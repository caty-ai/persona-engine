import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { engineCompatible, isBuildManifest } from "../build-manifest.js";
import { sha256 } from "../compile/hash.js";
import { isRecord, readJson } from "../json.js";
import {
  authorizeAdminTransition,
  authorizeAgentTransition,
  authorizeOwnerTransition,
  matchEligibleOwnerTriggerWithAudit,
  normalizeUtterance,
  resolveMode,
  resolveRoute,
  type RouteResolution,
  type TransitionAuthorization,
} from "../policy/index.js";
import {
  attemptStateTransition,
  readState,
  type StateSnapshot,
} from "../state/index.js";
import type {
  AdapterErrorContext,
  AdapterErrorReport,
  AuditEvent,
  BuildManifest,
  PolicyJson,
  RouteDecl,
  RuntimeDeps,
  SetInput,
  SetResult,
  StatusJson,
  TriggersJson,
  TurnInput,
  TurnResult,
} from "../types.js";

const IMPLEMENTATION = "ts";
const MODE_ID = /^[a-z0-9-]+$/u;
const DOMAIN_ID = /^[a-z0-9_-]{1,64}$/u;
let cachedCoreVersion: string | undefined;

type LoadedBuild = {
  manifest: BuildManifest;
  policy: PolicyJson;
  triggers: TriggersJson;
  blocks: Readonly<Record<string, string>>;
};

type InternalRuntimeDeps = RuntimeDeps & { adminDomain?: string | null };

type BuildLoad =
  | { ok: true; build: LoadedBuild }
  | { ok: false; policy?: PolicyJson; reason: string };

class BuildArtifactNotRegularError extends Error {}

type ArtifactIdentity = { dev: bigint; ino: bigint };

type BuildJsonRead = {
  value: unknown;
  leaf: ArtifactIdentity;
  parent: ArtifactIdentity;
};

type BuildFileRead = Omit<BuildJsonRead, "value"> & { bytes: Buffer };

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function nowFrom(deps: Pick<RuntimeDeps, "now">): Date {
  return (deps.now ?? (() => new Date()))();
}

function warn(deps: Pick<RuntimeDeps, "warn">, message: string): void {
  try {
    deps.warn?.(message);
  } catch {
    // Host warning hooks are best effort and must not affect resolution.
  }
}

function defaultEngineVersion(): string {
  if (cachedCoreVersion !== undefined) return cachedCoreVersion;
  try {
    const value = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as unknown;
    if (!isRecord(value) || typeof value.version !== "string") throw new Error("missing version");
    cachedCoreVersion = value.version;
    return cachedCoreVersion;
  } catch {
    throw new Error(
      "engineVersion was not provided and packages/core/package.json could not be read to derive a default — pass deps.engineVersion explicitly",
    );
  }
}

function isRoute(value: unknown): value is RouteDecl {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.match) &&
    Object.values(value.match).every((match) =>
      typeof match === "string" ||
      (isRecord(match) && typeof match.prefix === "string" && Object.keys(match).length === 1),
    ) &&
    Array.isArray(value.allowed_modes) &&
    value.allowed_modes.every((mode) => typeof mode === "string") &&
    (value.switching === "deny" ||
      value.switching === "explicit" ||
      value.switching === "explicit-and-agent") &&
    typeof value.state_domain === "string" &&
    DOMAIN_ID.test(value.state_domain) &&
    (value.owner_verified === undefined || typeof value.owner_verified === "boolean") &&
    (value.switching === "deny" || value.owner_verified === true);
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPathReplacementError(error: unknown): boolean {
  return errno(error) === "ELOOP" || errno(error) === "ENOTDIR";
}

async function verifyArtifactStat<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (errno(error) !== undefined) throw new BuildArtifactNotRegularError();
    throw error;
  }
}

async function readBuildFile(path: string): Promise<BuildFileRead> {
  const parentPath = dirname(path);
  const beforeParent = await lstat(parentPath, { bigint: true });
  if (!beforeParent.isDirectory() || beforeParent.isSymbolicLink()) {
    throw new BuildArtifactNotRegularError();
  }
  let parentHandle: Awaited<ReturnType<typeof open>>;
  try {
    parentHandle = await open(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isPathReplacementError(error)) throw new BuildArtifactNotRegularError();
    throw error;
  }
  try {
    const openedParent = await verifyArtifactStat(() => parentHandle.stat({ bigint: true }));
    if (
      !openedParent.isDirectory() ||
      openedParent.dev !== beforeParent.dev ||
      openedParent.ino !== beforeParent.ino
    ) throw new BuildArtifactNotRegularError();

    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new BuildArtifactNotRegularError();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isPathReplacementError(error)) throw new BuildArtifactNotRegularError();
      const verified = await verifyArtifactStat(() => lstat(path, { bigint: true }));
      if (!verified.isFile() || verified.isSymbolicLink()) {
        throw new BuildArtifactNotRegularError();
      }
      throw error;
    }
    try {
      const opened = await verifyArtifactStat(() => handle.stat({ bigint: true }));
      const verified = await verifyArtifactStat(() => lstat(path, { bigint: true }));
      const verifiedParent = await verifyArtifactStat(() => lstat(parentPath, { bigint: true }));
      const reopenedParent = await verifyArtifactStat(() => parentHandle.stat({ bigint: true }));
      if (
        !opened.isFile() ||
        !verified.isFile() ||
        verified.isSymbolicLink() ||
        !verifiedParent.isDirectory() ||
        verifiedParent.isSymbolicLink() ||
        reopenedParent.dev !== beforeParent.dev ||
        reopenedParent.ino !== beforeParent.ino ||
        verifiedParent.dev !== beforeParent.dev ||
        verifiedParent.ino !== beforeParent.ino ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.dev !== verified.dev ||
        opened.ino !== verified.ino
      ) throw new BuildArtifactNotRegularError();
      return {
        bytes: await handle.readFile(),
        leaf: { dev: opened.dev, ino: opened.ino },
        parent: { dev: verifiedParent.dev, ino: verifiedParent.ino },
      };
    } finally {
      await handle.close();
    }
  } finally {
    await parentHandle.close();
  }
}

export async function readBuildJson(path: string): Promise<BuildJsonRead> {
  const read = await readBuildFile(path);
  return { ...read, value: JSON.parse(read.bytes.toString("utf8")) as unknown };
}

async function verifyBuildJsonReads(
  buildRoot: string,
  reads: ReadonlyArray<readonly [string, BuildJsonRead]>,
): Promise<void> {
  const expectedParent = reads[0]?.[1].parent;
  if (expectedParent === undefined || reads.some(([, read]) =>
    !sameIdentity(read.parent, expectedParent)
  )) throw new BuildArtifactNotRegularError();

  const finalParent = await verifyArtifactStat(() => lstat(buildRoot, { bigint: true }));
  if (!finalParent.isDirectory() || finalParent.isSymbolicLink() ||
      !sameIdentity(finalParent, expectedParent)) {
    throw new BuildArtifactNotRegularError();
  }
  for (const [name, read] of reads) {
    const finalLeaf = await verifyArtifactStat(() =>
      lstat(resolve(buildRoot, name), { bigint: true })
    );
    if (!finalLeaf.isFile() || finalLeaf.isSymbolicLink() ||
        !sameIdentity(finalLeaf, read.leaf)) {
      throw new BuildArtifactNotRegularError();
    }
  }
}

export function isPolicy(value: unknown): value is PolicyJson {
  if (!(isRecord(value) &&
    Array.isArray(value.routes) &&
    value.routes.every(isRoute) &&
    Array.isArray(value.domains) &&
    value.domains.every((domain) => typeof domain === "string" && DOMAIN_ID.test(domain)) &&
    Array.isArray(value.modes) &&
    value.modes.every((mode) => typeof mode === "string") &&
    isRecord(value.default_route) &&
    typeof value.default_route.state_domain === "string" &&
    typeof value.audit_dir === "string")) {
    return false;
  }

  const domains = new Set(value.domains);
  const modes = new Set(value.modes);
  const routeIds = new Set<string>();
  if (!modes.has("public") || !domains.has(value.default_route.state_domain)) return false;
  return value.routes.every((route) => {
    if (routeIds.has(route.id) || !domains.has(route.state_domain)) return false;
    routeIds.add(route.id);
    return route.allowed_modes.every((mode) => mode === "public" || modes.has(mode));
  });
}

export function isTriggers(value: unknown): value is TriggersJson {
  return isRecord(value) &&
    value.normalization === 1 &&
    value.reserved_prefix === "/persona" &&
    isRecord(value.aliases) &&
    Object.values(value.aliases).every((mode) => typeof mode === "string");
}

async function loadBuild(deps: RuntimeDeps): Promise<BuildLoad> {
  const buildRoot = resolve(deps.installRoot, "build");
  let policyRead: BuildJsonRead;
  try {
    policyRead = await readBuildJson(resolve(buildRoot, "policy.json"));
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof BuildArtifactNotRegularError ? { policy: defaultPolicy() } : {}),
      reason: "policy-unavailable",
    };
  }
  const policy = isPolicy(policyRead.value) ? policyRead.value : undefined;
  if (policy === undefined) return { ok: false, reason: "policy-invalid" };
  const engineVersion = deps.engineVersion ?? defaultEngineVersion();
  try {
    const manifestRead = await readBuildJson(resolve(buildRoot, "manifest.json"));
    const triggersRead = await readBuildJson(resolve(buildRoot, "triggers.json"));
    await verifyBuildJsonReads(buildRoot, [
      ["policy.json", policyRead],
      ["manifest.json", manifestRead],
      ["triggers.json", triggersRead],
    ]);
    const manifest = manifestRead.value;
    const triggers = triggersRead.value;
    if (!isBuildManifest(manifest) || !engineCompatible(manifest.engine_version, engineVersion)) {
      return { ok: false, policy, reason: "manifest-incompatible" };
    }
    if (!isTriggers(triggers)) {
      return { ok: false, policy, reason: "triggers-incompatible" };
    }
    const manifestModes = new Set(Object.keys(manifest.modes));
    const policyModes = new Set(policy.modes.filter((mode) => mode !== "public"));
    if (manifestModes.size !== policyModes.size ||
        [...manifestModes].some((mode) => !policyModes.has(mode)) ||
        Object.values(triggers.aliases).some((mode) => mode !== "public" && !policyModes.has(mode))) {
      return { ok: false, policy, reason: "build-artifacts-inconsistent" };
    }
    let blocks: Record<string, string>;
    try {
      blocks = Object.fromEntries(await Promise.all(
        Object.entries(manifest.modes).map(async ([mode, metadata]) => {
          const path = resolve(buildRoot, "modes", `${mode}.md`);
          const { bytes } = await readBuildFile(path);
          if (bytes.byteLength !== metadata.bytes || sha256(bytes) !== metadata.sha256) {
            throw new Error("block does not match manifest");
          }
          return [mode, bytes.toString("utf8")] as const;
        }),
      ));
    } catch {
      return { ok: false, policy, reason: "block-unavailable" };
    }
    return { ok: true, build: { manifest, policy, triggers, blocks } };
  } catch {
    return { ok: false, policy, reason: "build-artifact-unavailable" };
  }
}

function defaultPolicy(): PolicyJson {
  return {
    routes: [],
    domains: ["quarantine"],
    modes: ["public"],
    default_route: { state_domain: "quarantine" },
    audit_dir: "audit/",
  };
}

function buildInvalidEvent(
  routeId: string,
  domain: string,
  timestamp: string,
  reason: string,
): AuditEvent {
  return {
    ts: timestamp,
    event: "build_invalid",
    route_id: routeId,
    domain,
    reason,
  };
}

function adminResolution(
  policy: PolicyJson,
  requestedDomain: string | null,
  timestamp: string,
): RouteResolution {
  const domain = requestedDomain ?? policy.default_route.state_domain;
  if (requestedDomain === null) {
    const route: RouteDecl = {
      id: "__admin__",
      match: {},
      allowed_modes: ["public"],
      switching: "deny",
      state_domain: domain,
      owner_verified: false,
    };
    return { route, route_id: route.id, state_domain: domain, audit: [] };
  }
  if (!policy.domains.includes(domain)) {
    const route: RouteDecl = {
      id: "__admin__",
      match: {},
      allowed_modes: ["public"],
      switching: "deny",
      state_domain: domain,
      owner_verified: false,
    };
    return {
      route,
      route_id: route.id,
      state_domain: domain,
      audit: [{
        ts: timestamp,
        event: "route_unresolved",
        route_id: route.id,
        domain,
        reason: "unknown-admin-domain",
      }],
    };
  }

  const allowedModes = new Set<string>(["public"]);
  for (const route of policy.routes) {
    if (route.state_domain === domain) {
      for (const mode of route.allowed_modes) allowedModes.add(mode);
    }
  }
  const route: RouteDecl = {
    id: "__admin__",
    match: {},
    allowed_modes: [...allowedModes],
    switching: "deny",
    state_domain: domain,
    owner_verified: false,
  };
  return { route, route_id: route.id, state_domain: domain, audit: [] };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolveAuditDirectory(
  installRoot: string,
  auditDir: string,
): Promise<string> {
  if (auditDir.length === 0 ||
      isAbsolute(auditDir) ||
      /^[A-Za-z]:[\\/]/u.test(auditDir) ||
      /^\\\\/u.test(auditDir)) {
    throw new Error("invalid compiled audit directory");
  }
  const parts = auditDir.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new Error("invalid compiled audit directory");
  }

  const rootReal = await realpath(installRoot);
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    const candidate = resolve(current, part);
    try {
      await lstat(candidate);
      current = await realpath(candidate);
      if (!contained(rootReal, current)) {
        throw new Error("compiled audit directory escapes install root");
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      const target = resolve(current, ...parts.slice(index));
      await mkdir(target, { recursive: true, mode: 0o700 });
      current = await realpath(target);
      if (!contained(rootReal, current)) {
        throw new Error("compiled audit directory escapes install root");
      }
      break;
    }
  }
  return current;
}

async function appendAudit(
  installRoot: string,
  policy: PolicyJson,
  events: readonly AuditEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const auditRoot = await resolveAuditDirectory(installRoot, policy.audit_dir);
  const auditPath = resolve(auditRoot, "audit.jsonl");
  try {
    const existing = await lstat(auditPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("audit.jsonl is not a regular file");
    }
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  // O_NOFOLLOW closes the final-component symlink race after lstat.
  const handle = await open(
    auditPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("audit.jsonl is not a regular file");
    const verifiedAuditRoot = await resolveAuditDirectory(installRoot, policy.audit_dir);
    const verifiedPath = resolve(verifiedAuditRoot, "audit.jsonl");
    const verified = await lstat(verifiedPath);
    if (!verified.isFile() || verified.dev !== opened.dev || verified.ino !== opened.ino) {
      throw new Error("audit.jsonl changed during open");
    }
    // Without openat(), an attacker can still race the tiny interval between
    // this post-open lstat comparison and the fd write. The fd itself remains
    // bound to the verified file object, but Node cannot lock the path walk.
    await handle.writeFile(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStatus(
  deps: RuntimeDeps,
  status: StatusJson,
): Promise<void> {
  const stateRoot = resolve(deps.installRoot, "state");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const temporary = resolve(stateRoot, `.status.json.tmp-${process.pid}-${randomUUID()}`);
  const target = resolve(stateRoot, "status.json");
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(status)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistTurnObservability(
  deps: RuntimeDeps,
  policy: PolicyJson | undefined,
  events: readonly AuditEvent[],
  status: StatusJson,
): Promise<boolean> {
  let degraded = false;
  if (events.length > 0) {
    if (policy === undefined) {
      degraded = true;
      warn(deps, "persona: audit unavailable because compiled policy is invalid");
    } else {
      try {
        await appendAudit(deps.installRoot, policy, events);
      } catch {
        degraded = true;
        warn(deps, "persona: failed to append audit.jsonl");
      }
    }
  }
  try {
    await writeStatus(deps, status);
  } catch {
    degraded = true;
    warn(deps, "persona: failed to update state/status.json");
  }
  return degraded;
}

async function persistSetAudit(
  deps: RuntimeDeps,
  policy: PolicyJson | undefined,
  events: readonly AuditEvent[],
): Promise<boolean> {
  if (events.length === 0) return false;
  if (policy === undefined) {
    warn(deps, "persona: audit unavailable because compiled policy is invalid");
    return true;
  }
  try {
    await appendAudit(deps.installRoot, policy, events);
    return false;
  } catch {
    warn(deps, "persona: failed to append audit.jsonl");
    return true;
  }
}

function statusFor(
  deps: RuntimeDeps,
  timestamp: string,
  routeId: string,
  mode: string,
  block: string,
  turnKey: string | undefined,
): StatusJson {
  return {
    ts: timestamp,
    route_id: routeId,
    mode,
    block_sha256: sha256(block),
    block_bytes: Buffer.byteLength(block, "utf8"),
    engine: `${IMPLEMENTATION}@${deps.engineVersion ?? defaultEngineVersion()}`,
    ...(turnKey === undefined ? {} : { turn_key: turnKey }),
  };
}

function withDegraded<T extends TurnResult | SetResult>(result: T, degraded: boolean): T {
  return degraded ? { ...result, degraded: true } : result;
}

async function finishInvalidTurn(
  input: TurnInput,
  deps: InternalRuntimeDeps,
  policy: PolicyJson | undefined,
  reason: string,
): Promise<TurnResult> {
  const timestamp = nowFrom(deps).toISOString();
  const effectivePolicy = policy ?? defaultPolicy();
  const resolution = deps.adminDomain === undefined
    ? resolveRoute(input.ctx, effectivePolicy, timestamp)
    : adminResolution(effectivePolicy, deps.adminDomain, timestamp);
  const audit = [
    ...resolution.audit,
    buildInvalidEvent(resolution.route_id, resolution.state_domain, timestamp, reason),
  ];
  const base: TurnResult = {
    mode: "public",
    block: "",
    route_id: resolution.route_id,
    state_domain: resolution.state_domain,
    transitioned: false,
    audit,
  };
  const degraded = await persistTurnObservability(
    deps,
    policy,
    audit,
    statusFor(deps, timestamp, base.route_id, base.mode, base.block, input.turn_key),
  );
  return withDegraded(base, degraded);
}

async function runTurn(input: TurnInput, deps: InternalRuntimeDeps): Promise<TurnResult> {
  const loaded = await loadBuild(deps);
  if (!loaded.ok) {
    return finishInvalidTurn(input, deps, loaded.policy, loaded.reason);
  }

  const timestamp = nowFrom(deps).toISOString();
  const { manifest, policy, triggers, blocks } = loaded.build;
  const resolution = deps.adminDomain === undefined
    ? resolveRoute(input.ctx, policy, timestamp)
    : adminResolution(policy, deps.adminDomain, timestamp);
  const audit: AuditEvent[] = [...resolution.audit];
  const stateRoot = resolve(deps.installRoot, "state");
  const initial = await readState(
    stateRoot,
    resolution.state_domain,
    resolution.route_id,
    { now: deps.now },
  );
  audit.push(...initial.audit);

  let snapshot: StateSnapshot = initial.state;
  let transitioned = false;
  let rejected: TurnResult["rejected"];

  if (initial.ok && input.utterance !== undefined && deps.adminDomain === undefined) {
    const trigger = matchEligibleOwnerTriggerWithAudit(
      normalizeUtterance(input.utterance),
      triggers,
      resolution.route,
      input.actor,
      timestamp,
    );
    audit.push(...trigger.audit);
    if (trigger.requested_mode !== undefined) {
      const authorization = authorizeOwnerTransition(
        resolution.route,
        snapshot.mode,
        trigger.requested_mode,
        timestamp,
      );
      audit.push(...authorization.audit);
      if (!authorization.allowed) {
        rejected = authorization.rejected;
      } else {
        const attempt = await attemptStateTransition(
          {
            stateRoot,
            domain: resolution.state_domain,
            expectedRevision: snapshot.revision,
            mode: trigger.requested_mode,
            setBy: "owner",
            routeId: resolution.route_id,
          },
          (fresh) => {
            const freshAuthorization = authorizeOwnerTransition(
              resolution.route,
              fresh.mode,
              trigger.requested_mode as string,
              nowFrom(deps).toISOString(),
            );
            return freshAuthorization.allowed
              ? { allowed: true }
              : { allowed: false, reason: freshAuthorization.rejected?.reason ?? "transition no longer authorized" };
          },
          { now: deps.now },
        );
        snapshot = attempt.state;
        transitioned = attempt.transitioned;
        audit.push(...attempt.audit);
        if (attempt.status === "rejected") rejected = attempt.rejected;
      }
    }
  }

  let mode = "public";
  if (initial.ok && snapshot.mode !== "public") {
    const modeResolution = resolveMode(snapshot, resolution, timestamp);
    mode = modeResolution.mode;
    audit.push(...modeResolution.audit);
  } else if (initial.ok) {
    mode = snapshot.mode;
  }

  let block = "";
  if (mode !== "public") {
    const metadata = manifest.modes[mode];
    if (metadata === undefined || !MODE_ID.test(mode)) {
      audit.push(buildInvalidEvent(resolution.route_id, resolution.state_domain, timestamp, "mode-missing-from-manifest"));
      mode = "public";
    } else {
      const snapshotBlock = blocks[mode];
      if (snapshotBlock === undefined) {
        audit.push(buildInvalidEvent(resolution.route_id, resolution.state_domain, timestamp, "block-unavailable"));
        mode = "public";
        block = "";
      } else {
        block = snapshotBlock;
      }
    }
  }

  const base: TurnResult = {
    mode,
    block,
    route_id: resolution.route_id,
    state_domain: resolution.state_domain,
    transitioned,
    ...(rejected === undefined ? {} : { rejected }),
    audit,
  };
  const degraded = await persistTurnObservability(
    deps,
    policy,
    audit,
    statusFor(deps, timestamp, base.route_id, base.mode, base.block, input.turn_key),
  );
  return withDegraded(base, degraded);
}

export async function turn(input: TurnInput, deps: RuntimeDeps): Promise<TurnResult> {
  return runTurn(input, deps);
}

/**
 * Trusted CLI-only admin path. This bypasses normal ctx route resolution and
 * owner utterance-trigger handling by synthesizing an admin domain resolution.
 * Never expose it to an adapter or from the public package surface.
 */
export async function cliInternalTurnAdmin(
  input: TurnInput,
  deps: RuntimeDeps,
  domain: string | null,
): Promise<TurnResult> {
  return runTurn(input, { ...deps, adminDomain: domain });
}

function reauthorizeSet(
  input: SetInput,
  policy: PolicyJson,
  route: RouteDecl | undefined,
  fresh: StateSnapshot,
  timestamp: string,
): TransitionAuthorization {
  return input.actor === "admin"
    ? authorizeAdminTransition(input, policy, fresh.mode, timestamp)
    : authorizeAgentTransition(input, route as RouteDecl, fresh.mode, timestamp);
}

export async function set(input: SetInput, deps: RuntimeDeps): Promise<SetResult> {
  const loaded = await loadBuild(deps);
  const timestamp = nowFrom(deps).toISOString();
  if (!loaded.ok) {
    const policy = loaded.policy;
    const resolution = input.actor === "agent"
      ? resolveRoute(input.ctx, policy ?? defaultPolicy(), timestamp)
      : undefined;
    const rawAdminDomain = input.actor === "admin"
      ? (input as { domain?: unknown }).domain
      : undefined;
    const domain = input.actor === "admin"
      ? (typeof rawAdminDomain === "string" ? rawAdminDomain : "quarantine")
      : resolution?.state_domain ?? "quarantine";
    const routeId = input.actor === "admin" ? "__admin__" : resolution?.route_id ?? "__default__";
    const audit = [
      ...(resolution?.audit ?? []),
      buildInvalidEvent(routeId, domain, timestamp, loaded.reason),
    ];
    const base: SetResult = {
      ok: false,
      mode: "public",
      transitioned: false,
      rejected: {
        requested_mode: input.requested_mode,
        reason: "build artifacts are unavailable or incompatible",
      },
      audit,
    };
    return withDegraded(base, await persistSetAudit(deps, policy, audit));
  }

  const { policy } = loaded.build;
  if (input.actor === "admin" && typeof (input as { domain?: unknown }).domain !== "string") {
    const reason = "requested domain is required";
    const rejected = { requested_mode: input.requested_mode, reason };
    const audit: AuditEvent[] = [{
      ts: timestamp,
      event: "switch_rejected",
      route_id: "__admin__",
      domain: policy.default_route.state_domain,
      from: "public",
      reason,
    }];
    const base: SetResult = {
      ok: false,
      mode: "public",
      transitioned: false,
      rejected,
      audit,
    };
    return withDegraded(base, await persistSetAudit(deps, policy, audit));
  }
  const routeResolution = input.actor === "agent"
    ? resolveRoute(input.ctx, policy, timestamp)
    : undefined;
  const route = routeResolution?.route;
  const routeId = input.actor === "admin" ? "__admin__" : routeResolution?.route_id ?? "__default__";
  const domain = input.actor === "admin" ? input.domain : routeResolution?.state_domain ?? "quarantine";
  const audit: AuditEvent[] = [...(routeResolution?.audit ?? [])];

  if (input.actor === "admin" && !policy.domains.includes(input.domain)) {
    const authorization = authorizeAdminTransition(input, policy, "public", timestamp);
    audit.push(...authorization.audit);
    const base: SetResult = {
      ok: false,
      mode: "public",
      transitioned: false,
      ...(authorization.rejected === undefined ? {} : { rejected: authorization.rejected }),
      audit,
    };
    return withDegraded(base, await persistSetAudit(deps, policy, audit));
  }

  const stateRoot = resolve(deps.installRoot, "state");
  const initial = await readState(stateRoot, domain, routeId, { now: deps.now });
  audit.push(...initial.audit);
  if (!initial.ok) {
    const base: SetResult = {
      ok: false,
      mode: "public",
      transitioned: false,
      audit,
    };
    return withDegraded(base, await persistSetAudit(deps, policy, audit));
  }

  const authorization = input.actor === "admin"
    ? authorizeAdminTransition(input, policy, initial.state.mode, timestamp)
    : authorizeAgentTransition(input, route as RouteDecl, initial.state.mode, timestamp);
  audit.push(...authorization.audit);
  if (!authorization.allowed) {
    const base: SetResult = {
      ok: false,
      mode: initial.state.mode,
      transitioned: false,
      ...(authorization.rejected === undefined ? {} : { rejected: authorization.rejected }),
      audit,
    };
    return withDegraded(base, await persistSetAudit(deps, policy, audit));
  }

  const attempt = await attemptStateTransition(
    {
      stateRoot,
      domain,
      expectedRevision: initial.state.revision,
      mode: input.requested_mode,
      setBy: input.actor,
      routeId,
    },
    (fresh) => {
      const freshAuthorization = reauthorizeSet(
        input,
        policy,
        route,
        fresh,
        nowFrom(deps).toISOString(),
      );
      return freshAuthorization.allowed
        ? { allowed: true }
        : { allowed: false, reason: freshAuthorization.rejected?.reason ?? "transition no longer authorized" };
    },
    { now: deps.now },
  );
  audit.push(...attempt.audit);
  const base: SetResult = {
    ok: attempt.status === "applied",
    mode: attempt.mode,
    transitioned: attempt.transitioned,
    ...(attempt.status === "rejected" ? { rejected: attempt.rejected } : {}),
    audit,
  };
  return withDegraded(base, await persistSetAudit(deps, policy, audit));
}

function adapterErrorCategory(error: unknown): string {
  const name = error instanceof Error
    ? error.name
    : (isRecord(error) && typeof error.name === "string" ? error.name : undefined);
  return name !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(name)
    ? name
    : "adapter-exception";
}

function isStatus(value: unknown): value is StatusJson {
  return isRecord(value) &&
    typeof value.ts === "string" &&
    typeof value.route_id === "string" &&
    typeof value.mode === "string" &&
    typeof value.block_sha256 === "string" &&
    typeof value.block_bytes === "number" &&
    typeof value.engine === "string" &&
    (value.turn_key === undefined || typeof value.turn_key === "string");
}

function statusDomain(policy: PolicyJson, status: StatusJson): string | undefined {
  if (status.route_id === "__default__") return policy.default_route.state_domain;
  return policy.routes.find((route) => route.id === status.route_id)?.state_domain;
}

async function correctAdapterErrorStatus(
  deps: RuntimeDeps,
  policy: PolicyJson,
  ctx: AdapterErrorContext,
  timestamp: string,
): Promise<boolean> {
  if (ctx.domain === undefined) return false;
  let status: StatusJson;
  try {
    const value = await readJson(resolve(deps.installRoot, "state", "status.json"));
    if (!isStatus(value)) return false;
    status = value;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    warn(deps, "persona: failed to inspect state/status.json after adapter error");
    return true;
  }

  if (statusDomain(policy, status) !== ctx.domain ||
      (ctx.route_id !== undefined && status.route_id !== ctx.route_id) ||
      (ctx.turn_key !== undefined && status.turn_key !== ctx.turn_key)) {
    return false;
  }

  try {
    await writeStatus(deps, {
      ...status,
      ts: timestamp,
      mode: "public",
      block_sha256: sha256(""),
      block_bytes: 0,
    });
    return false;
  } catch {
    warn(deps, "persona: failed to correct state/status.json after adapter error");
    return true;
  }
}

export async function report_adapter_error(
  error: unknown,
  ctx: AdapterErrorContext,
): Promise<AdapterErrorReport> {
  if (!isRecord(ctx) || typeof ctx.installRoot !== "string" || ctx.installRoot.length === 0) {
    throw new TypeError("report_adapter_error requires ctx.installRoot");
  }
  const deps: RuntimeDeps = {
    installRoot: ctx.installRoot,
    ...(ctx.engineVersion === undefined ? {} : { engineVersion: ctx.engineVersion }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
    ...(ctx.warn === undefined ? {} : { warn: ctx.warn }),
  };
  const timestamp = nowFrom(deps).toISOString();
  let policy: PolicyJson | undefined;
  try {
    const read = await readBuildJson(resolve(deps.installRoot, "build", "policy.json"));
    if (isPolicy(read.value)) policy = read.value;
  } catch {
    // The report below remains available to the caller even if persistence is not.
  }
  const event: AuditEvent = {
    ts: timestamp,
    event: "adapter_error",
    route_id: "__adapter__",
    domain: policy?.default_route.state_domain ?? "quarantine",
    reason: adapterErrorCategory(error),
  };
  const auditDegraded = await persistSetAudit(deps, policy, [event]);
  const statusDegraded = policy === undefined
    ? false
    : await correctAdapterErrorStatus(deps, policy, ctx, timestamp);
  const degraded = auditDegraded || statusDegraded;
  return { degraded, audit: [event] };
}

export type { RuntimeDeps } from "../types.js";
