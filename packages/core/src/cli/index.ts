import {
  constants,
  readFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isBuildManifest, SEMVER } from "../build-manifest.js";
import { initCommand } from "./init.js";
import { buildPack } from "../compile/index.js";
import { parseSafeYaml, SafeYamlError } from "../compile/yaml.js";
import { resolveAuditRoot, runDoctor } from "../doctor/index.js";
import { isRecord } from "../json.js";
import { readState } from "../state/index.js";
import type {
  AdapterErrorContext,
  AuditEvent,
  BuildManifest,
  PolicyJson,
  SetResult,
  StatusJson,
  TurnInput,
} from "../types.js";
import {
  cliInternalTurnAdmin,
  isPolicy,
  readBuildJson,
  report_adapter_error,
  set,
  turn,
} from "../turn/index.js";

const PACKAGE = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };
const ENGINE_VERSION = PACKAGE.version;

const EXIT_SUCCESS = 0;
const EXIT_BUILD_ERROR = 1;
const EXIT_POLICY_REJECT = 2;
const EXIT_ERROR = 3;
const MODE_ID = /^[a-z0-9-]+$/u;
const DOMAIN_ID = /^[a-z0-9_-]{1,64}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;
const INVALID_MODE_ID = "<invalid-mode-id>";
const INVALID_ROUTE_ID = "<invalid-route-id>";
const INVALID_TIMESTAMP = "<invalid-timestamp>";
const DISPLAY_FIELD_MAX_CHARS = 256;
// Display-layer defensive cap only: SPEC.md defines no mode-id maximum; do not treat or backport this as a compile-time/schema restriction.
const isValidModeId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= DISPLAY_FIELD_MAX_CHARS && MODE_ID.test(value);

class CliBuildError extends Error {}

type ParsedArgs = {
  positionals: string[];
  options: Map<string, string>;
};

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = equals === -1 ? value.slice(2) : value.slice(2, equals);
    if (name === "json" || name === "yes" || name === "stdin-json") {
      if (equals !== -1) throw new Error(`--${name} does not take a value`);
      if (options.has(name)) throw new Error(`--${name} may only be specified once`);
      options.set(name, "");
      continue;
    }
    const optionValue = equals === -1 ? args[index + 1] : value.slice(equals + 1);
    if (name.length === 0 || optionValue === undefined || optionValue.startsWith("--")) {
      throw new Error(`--${name || "option"} requires a value`);
    }
    if (options.has(name)) throw new Error(`--${name} may only be specified once`);
    options.set(name, optionValue);
    if (equals === -1) index += 1;
  }
  return { positionals, options };
}

function rejectUnknownOptions(parsed: ParsedArgs, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const name of parsed.options.keys()) {
    if (!accepted.has(name)) throw new Error(`unknown option --${name}`);
  }
}

function installRoot(parsed: ParsedArgs): string {
  return resolve(parsed.options.get("dir") ?? process.cwd());
}

function requiredOption(parsed: ParsedArgs, name: string): string {
  const value = parsed.options.get(name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function oneMode(parsed: ParsedArgs, command: string): string {
  if (parsed.positionals.length !== 1) throw new Error(`usage: persona ${command} <mode> --domain <domain>`);
  return parsed.positionals[0] as string;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runtimeExitCode(
  result: { audit: AuditEvent[]; degraded?: boolean; ok?: boolean },
): number {
  if (result.audit.some((event) => event.event === "build_invalid")) return EXIT_BUILD_ERROR;
  if (result.audit.some((event) => event.event === "switch_rejected")) return EXIT_POLICY_REJECT;
  if (result.degraded === true ||
      result.ok === false ||
      result.audit.some((event) => event.event === "state_error")) {
    return EXIT_ERROR;
  }
  return EXIT_SUCCESS;
}

async function readBuildArtifact(root: string, name: string): Promise<unknown> {
  try {
    return (await readBuildJson(resolve(root, "build", name))).value;
  } catch {
    throw new CliBuildError(`build artifacts missing or invalid (${name}); run persona build`);
  }
}

async function readPolicy(root: string): Promise<PolicyJson> {
  const value = await readBuildArtifact(root, "policy.json");
  if (!isPolicy(value)) {
    throw new CliBuildError("build/policy.json is invalid; run persona build");
  }
  return value;
}

async function readManifest(root: string): Promise<BuildManifest> {
  const value = await readBuildArtifact(root, "manifest.json");
  if (!isBuildManifest(value)) {
    throw new CliBuildError("build/manifest.json is invalid; run persona build");
  }
  return value;
}

function resolvePack(root: string, parsed: ParsedArgs): { installFile: string; packDir: string } {
  const installFile = resolve(parsed.options.get("install") ?? resolve(root, "install.yml"));
  const explicitPack = parsed.options.get("pack");
  if (explicitPack !== undefined) return { installFile, packDir: resolve(explicitPack) };

  const install = parseSafeYaml(readFileSync(installFile, "utf8"));
  if (!isRecord(install) || typeof install.pack !== "string" || install.pack.length === 0) {
    throw new Error("install.yml must contain a local pack path");
  }
  const pack = install.pack;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(pack)) {
    throw new Error("remote pack URLs are not supported by this M1 CLI");
  }
  return { installFile, packDir: resolve(dirname(installFile), pack) };
}

function buildCommand(parsed: ParsedArgs): number {
  rejectUnknownOptions(parsed, ["dir", "install", "pack"]);
  if (parsed.positionals.length !== 0) throw new Error("usage: persona build [--dir <directory>]");
  const root = installRoot(parsed);
  let paths: ReturnType<typeof resolvePack>;
  try {
    paths = resolvePack(root, parsed);
  } catch (error) {
    const code = error instanceof SafeYamlError ? "E_PARSE" : "E_SCHEMA_VERSION";
    printJson({ ok: false, errors: [{ code, message: error instanceof Error ? error.message : String(error) }] });
    return EXIT_BUILD_ERROR;
  }
  const result = buildPack({ ...paths, engineVersion: ENGINE_VERSION, outputDir: resolve(root, "build") });
  if (!result.ok) {
    printJson({ ok: false, errors: result.errors });
    return EXIT_BUILD_ERROR;
  }
  printJson({ ok: true, output_dir: result.outputDir, manifest: result.artifacts.manifest });
  return EXIT_SUCCESS;
}

function setCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "domain"]);
  const requestedMode = oneMode(parsed, "set");
  const root = installRoot(parsed);
  return set(
    { actor: "admin", ctx: null, requested_mode: requestedMode, domain: requiredOption(parsed, "domain") },
    { installRoot: root, engineVersion: ENGINE_VERSION, warn: (message: string) => process.stderr.write(`persona: ${message}\n`) },
  ).then((result: SetResult) => {
    printJson(result);
    return runtimeExitCode(result);
  });
}

async function getCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "domain", "json"]);
  if (parsed.positionals.length !== 0) throw new Error("usage: persona get [--domain <domain>] [--json]");
  const root = installRoot(parsed);
  const policy = await readPolicy(root);
  const explicitDomain = parsed.options.get("domain");
  if (explicitDomain !== undefined && !policy.domains.includes(explicitDomain)) {
    throw new Error(`unknown state domain '${explicitDomain}'`);
  }
  const status = await readStatus(root);
  const domains = explicitDomain === undefined ? policy.domains : [explicitDomain];
  const results = await Promise.all(domains.map(async (domain) => {
    const result = await readState(resolve(root, "state"), domain, "__admin__");
    const validStateMode = isValidModeId(result.state.mode);
    const validStateSetAt = result.state.set_at === undefined || isCanonicalIso8601(result.state.set_at);
    const validStateRouteId = result.state.route_id === undefined || isSafeDisplayString(result.state.route_id);
    const applicability = status === undefined
      ? undefined
      : statusApplicability(policy, status.route_id, domain);
    const freshness = status === undefined
      ? { available: false as const }
      : applicability !== undefined && !applicability.applicable
        ? {
            available: true as const,
            applicable: false as const,
            reason: applicability.reason,
          }
        : {
            available: true as const,
            applicable: true as const,
            matches_current_mode: validStateMode && status.mode === result.state.mode,
            last_injected: {
              ts: status.ts,
              route_id: status.route_id,
              mode: status.mode,
              block_sha256: status.block_sha256,
              block_bytes: status.block_bytes,
            },
          };
    return {
      domain,
      v: result.state.v,
      revision: result.state.revision,
      mode: validStateMode ? result.state.mode : INVALID_MODE_ID,
      ...(result.state.set_by === undefined ? {} : { set_by: result.state.set_by }),
      ...(result.state.set_at === undefined
        ? {}
        : { set_at: validStateSetAt ? result.state.set_at : INVALID_TIMESTAMP }),
      ...(result.state.route_id === undefined
        ? {}
        : { route_id: validStateRouteId ? result.state.route_id : INVALID_ROUTE_ID }),
      state_error: !result.ok || !validStateMode || !validStateSetAt || !validStateRouteId,
      freshness,
    };
  }));
  if (parsed.options.has("json")) {
    printJson(explicitDomain !== undefined || results.length === 1 ? results[0] : { domains: results });
  } else {
    process.stdout.write(`${results.map(renderDomainStatus).join("\n\n")}\n`);
  }
  return results.every((result) => !result.state_error) ? EXIT_SUCCESS : EXIT_ERROR;
}

async function turnCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "domain", "stdin-json"]);
  if (parsed.options.has("stdin-json")) return stdinJsonTurnCommand(parsed);
  if (parsed.positionals.length !== 0) throw new Error("usage: persona turn [--domain <domain>] | turn --stdin-json [--dir <directory>]");
  const root = installRoot(parsed);
  const domain = parsed.options.get("domain") ?? null;
  if (domain !== null) {
    const policy = await readPolicy(root);
    if (!policy.domains.includes(domain)) throw new Error(`unknown state domain '${domain}'`);
  }
  const result = await cliInternalTurnAdmin(
    { ctx: {}, actor: "unknown" },
    {
      installRoot: root,
      engineVersion: ENGINE_VERSION,
      warn: (message: string) => process.stderr.write(`persona: ${message}\n`),
    },
    domain,
  );
  printJson(result);
  return runtimeExitCode(result);
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  if (input.trim() === "") throw new Error("stdin JSON input is required");
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("stdin must contain valid JSON");
  }
}

function parseTurnInput(value: unknown): TurnInput {
  // Local CLI callers are trusted; turn() enforces the route's owner_verified policy.
  if (!isRecord(value) || !isRecord(value.ctx) ||
      (value.actor !== "owner" && value.actor !== "unknown") ||
      (value.utterance !== undefined && typeof value.utterance !== "string") ||
      (value.turn_key !== undefined && typeof value.turn_key !== "string")) {
    throw new Error("stdin JSON must be a TurnInput with object ctx and actor 'owner' or 'unknown'");
  }
  return {
    ctx: value.ctx,
    actor: value.actor,
    ...(value.utterance === undefined ? {} : { utterance: value.utterance }),
    ...(value.turn_key === undefined ? {} : { turn_key: value.turn_key }),
  };
}

async function stdinJsonTurnCommand(parsed: ParsedArgs): Promise<number> {
  if (parsed.positionals.length !== 0 || parsed.options.has("domain")) {
    throw new Error("usage: persona turn --stdin-json [--dir <directory>]");
  }
  const input = parseTurnInput(await readStdinJson());
  const result = await turn(input, {
    installRoot: installRoot(parsed),
    engineVersion: ENGINE_VERSION,
    warn: (message: string) => process.stderr.write(`persona: ${message}\n`),
  });
  printJson(result);
  return runtimeExitCode(result);
}

function parseAdapterErrorInput(value: unknown, root: string): { error: unknown; ctx: AdapterErrorContext } {
  if (!isRecord(value)) throw new Error("stdin JSON must be an adapter error object");
  const context = value.ctx === undefined ? {} : value.ctx;
  if (!isRecord(context) ||
      (context.route_id !== undefined && typeof context.route_id !== "string") ||
      (context.domain !== undefined && typeof context.domain !== "string") ||
      (context.turn_key !== undefined && typeof context.turn_key !== "string")) {
    throw new Error("adapter error ctx fields route_id, domain, and turn_key must be strings");
  }
  return {
    error: value.error,
    ctx: {
      installRoot: root,
      ...(context.route_id === undefined ? {} : { route_id: context.route_id }),
      ...(context.domain === undefined ? {} : { domain: context.domain }),
      ...(context.turn_key === undefined ? {} : { turn_key: context.turn_key }),
    },
  };
}

async function reportAdapterErrorCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "stdin-json"]);
  if (!parsed.options.has("stdin-json") || parsed.positionals.length !== 0) {
    throw new Error("usage: persona report-adapter-error --stdin-json [--dir <directory>]");
  }
  const input = parseAdapterErrorInput(await readStdinJson(), installRoot(parsed));
  const result = await report_adapter_error(input.error, input.ctx);
  printJson(result);
  return runtimeExitCode(result);
}

async function listCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "json"]);
  if (parsed.positionals.length !== 0) throw new Error("usage: persona list [--dir <directory>] [--json]");
  const root = installRoot(parsed);
  const [policy, manifest] = await Promise.all([readPolicy(root), readManifest(root)]);
  const output: ListOutput = {
    modes: Object.entries(manifest.modes).map(([id, metadata]) => {
      const validId = isValidModeId(id);
      return {
        id: validId ? id : INVALID_MODE_ID,
        bytes: metadata.bytes,
        tokens: metadata.tokens,
        has_voice_hint: metadata.voice_hint !== undefined,
        data_error: !validId,
      };
    }),
    routes: policy.routes.map((route) => {
      const validId = isSafeDisplayString(route.id);
      const validAllowedModes = route.allowed_modes.map((mode) => isValidModeId(mode));
      return {
        id: validId ? route.id : INVALID_ROUTE_ID,
        allowed_modes: route.allowed_modes.map((mode, index) =>
          validAllowedModes[index] === true ? mode : INVALID_MODE_ID
        ),
        switching: route.switching,
        owner_verified: route.owner_verified ?? false,
        data_error: !validId || validAllowedModes.includes(false),
      };
    }),
    public_implicitly_allowed: true,
  };
  if (parsed.options.has("json")) {
    printJson(output);
  } else {
    process.stdout.write(renderList(output));
  }
  return EXIT_SUCCESS;
}

async function readStatus(root: string): Promise<StatusJson | undefined> {
  let handle;
  try {
    handle = await open(
      resolve(root, "state", "status.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    const value = JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
    if (!isRecord(value) ||
        typeof value.ts !== "string" ||
        !isCanonicalIso8601(value.ts) ||
        !isSafeDisplayString(value.route_id) ||
        !isValidModeId(value.mode) ||
        typeof value.block_sha256 !== "string" ||
        !SHA256_HEX.test(value.block_sha256) ||
        typeof value.block_bytes !== "number" ||
        !Number.isSafeInteger(value.block_bytes) ||
        value.block_bytes < 0 ||
        typeof value.engine !== "string" ||
        !isStatusEngine(value.engine) ||
        (value.turn_key !== undefined && typeof value.turn_key !== "string")) return undefined;
    return {
      ts: value.ts,
      route_id: value.route_id,
      mode: value.mode,
      block_sha256: value.block_sha256,
      block_bytes: value.block_bytes,
      engine: value.engine,
      ...(value.turn_key === undefined ? {} : { turn_key: value.turn_key }),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type StatusApplicability =
  | { applicable: true }
  | {
      applicable: false;
      reason: "no_domain_match" | "ambiguous_sentinel_collision";
    };

function statusApplicability(
  policy: PolicyJson,
  routeId: string,
  domain: string,
): StatusApplicability {
  const isSentinel = routeId === "__default__" || routeId === "__admin__";
  if (isSentinel && policy.routes.some((route) => route.id === routeId)) {
    return { applicable: false, reason: "ambiguous_sentinel_collision" };
  }
  if (routeId === "__default__") {
    return policy.default_route.state_domain === domain
      ? { applicable: true }
      : { applicable: false, reason: "no_domain_match" };
  }
  return policy.routes.some((route) => route.id === routeId && route.state_domain === domain)
    ? { applicable: true }
    : { applicable: false, reason: "no_domain_match" };
}

type DomainStatus = {
  domain: string;
  v: number;
  mode: string;
  revision: number;
  set_by?: string;
  set_at?: string;
  route_id?: string;
  state_error: boolean;
  freshness:
    | { available: false }
    | {
        available: true;
        applicable: false;
        reason: "no_domain_match" | "ambiguous_sentinel_collision";
      }
    | {
        available: true;
        applicable: true;
        matches_current_mode: boolean;
        last_injected: Pick<StatusJson, "ts" | "route_id" | "mode" | "block_sha256" | "block_bytes">;
      };
};

function renderDomainStatus(result: DomainStatus): string {
  const lines = [
    `Domain: ${result.domain}`,
    `  mode: ${result.mode}`,
    `  revision: ${result.revision}`,
  ];
  if (result.set_by !== undefined) lines.push(`  set_by: ${result.set_by}`);
  if (result.set_at !== undefined) lines.push(`  set_at: ${result.set_at}`);
  if (!result.freshness.available) {
    lines.push("  freshness: unavailable (status.json is absent or malformed)");
  } else if (!result.freshness.applicable) {
    lines.push(result.freshness.reason === "ambiguous_sentinel_collision"
      ? "  freshness: ambiguous (a declared route id collides with a reserved identifier — see persona doctor)"
      : "  freshness: not applicable to this domain");
    lines.push("  note: status.json records only the most recent injected route/mode, not per-domain status");
  } else {
    const status = result.freshness.last_injected;
    lines.push(result.freshness.matches_current_mode
      ? "  freshness: matches the last injected mode"
      : "  freshness: stale/mismatched with the last injected mode");
    lines.push(`  last_injected: mode=${status.mode} route=${status.route_id} at=${status.ts}`);
    lines.push("  note: status.json records only the most recent injected route/mode, not per-domain status");
  }
  if (result.state_error) lines.push("  state_error: true");
  return lines.join("\n");
}

type ListOutput = {
  modes: Array<{ id: string; bytes: number; tokens: number; has_voice_hint: boolean; data_error: boolean }>;
  routes: Array<{
    id: string;
    allowed_modes: string[];
    switching: "deny" | "explicit" | "explicit-and-agent";
    owner_verified: boolean;
    data_error: boolean;
  }>;
  public_implicitly_allowed: true;
};

function renderList(output: ListOutput): string {
  const lines = ["Modes:"];
  if (output.modes.length === 0) lines.push("  (none)");
  for (const mode of output.modes) {
    lines.push(`  ${mode.id}: bytes=${mode.bytes} tokens=${mode.tokens} voice_hint=${mode.has_voice_hint ? "yes" : "no"} data_error=${mode.data_error ? "true" : "false"}`);
  }
  lines.push("", "Routes:");
  if (output.routes.length === 0) lines.push("  (none)");
  for (const route of output.routes) {
    lines.push(`  ${route.id}: allowed_modes=[${route.allowed_modes.join(", ")}] switching=${route.switching} owner_verified=${route.owner_verified ? "yes" : "no"} data_error=${route.data_error ? "true" : "false"}`);
  }
  lines.push("", "Note: public is implicitly allowed on every route, whether or not allowed_modes lists it.");
  return `${lines.join("\n")}\n`;
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return isRecord(value) &&
    typeof value.ts === "string" &&
    isCanonicalIso8601(value.ts) &&
    isSafeDisplayString(value.event) &&
    isSafeDisplayString(value.route_id) &&
    typeof value.domain === "string" &&
    DOMAIN_ID.test(value.domain) &&
    (value.from === undefined || isValidModeId(value.from)) &&
    (value.to === undefined || isValidModeId(value.to)) &&
    (value.set_by === undefined || value.set_by === "owner" || value.set_by === "agent" || value.set_by === "admin") &&
    (value.reason === undefined || isSafeDisplayString(value.reason));
}

function isCanonicalIso8601(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isSafeDisplayString(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= DISPLAY_FIELD_MAX_CHARS &&
    PRINTABLE_ASCII.test(value);
}

function isStatusEngine(value: string): boolean {
  const match = /^(ts|py)@(.+)$/u.exec(value);
  return match !== null && SEMVER.test(match[2] ?? "");
}

async function readAuditFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("audit.jsonl is not a regular file");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function positiveIntegerOption(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = parsed.options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

async function auditCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "domain", "event", "since", "limit", "json"]);
  if (parsed.positionals.length !== 0) {
    throw new Error("usage: persona audit [--domain <domain>] [--event <name>] [--since <ISO8601>] [--limit <N>] [--json]");
  }
  const root = installRoot(parsed);
  const policy = await readPolicy(root);
  const domain = parsed.options.get("domain");
  if (domain !== undefined && !policy.domains.includes(domain)) {
    throw new Error(`unknown state domain '${domain}'`);
  }
  const eventName = parsed.options.get("event");
  if (eventName !== undefined && eventName.length === 0) throw new Error("--event requires a value");
  const sinceRaw = parsed.options.get("since");
  if (sinceRaw !== undefined && !isCanonicalIso8601(sinceRaw)) {
    throw new Error("--since must be a valid canonical ISO8601 timestamp");
  }
  const since = sinceRaw === undefined ? undefined : Date.parse(sinceRaw);
  const limit = positiveIntegerOption(parsed, "limit", 50);
  const auditRoot = await resolveAuditRoot(root, policy.audit_dir);
  const source = await readAuditFile(resolve(auditRoot, "audit.jsonl"));

  let skippedMalformedLines = 0;
  const matching: AuditEvent[] = [];
  for (const line of source.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      skippedMalformedLines += 1;
      continue;
    }
    if (!isAuditEvent(value)) {
      skippedMalformedLines += 1;
      continue;
    }
    const event: AuditEvent = {
      ts: value.ts,
      event: value.event,
      route_id: value.route_id,
      domain: value.domain,
      ...(value.from === undefined ? {} : { from: value.from }),
      ...(value.to === undefined ? {} : { to: value.to }),
      ...(value.set_by === undefined ? {} : { set_by: value.set_by }),
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
    if (domain !== undefined && event.domain !== domain) continue;
    if (eventName !== undefined && event.event !== eventName) continue;
    if (since !== undefined && Date.parse(event.ts) < since) continue;
    matching.push(event);
  }
  const events = matching
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
    .slice(0, limit);
  if (parsed.options.has("json")) {
    printJson({ events, skipped_malformed_lines: skippedMalformedLines });
  } else {
    process.stdout.write(renderAudit(events, skippedMalformedLines));
  }
  return EXIT_SUCCESS;
}

function renderAudit(events: AuditEvent[], skippedMalformedLines: number): string {
  const lines = [`Audit events (${events.length}, newest first):`];
  if (events.length === 0) lines.push("  (none)");
  for (const event of events) {
    const details = [
      `route=${event.route_id}`,
      `domain=${event.domain}`,
      ...(event.from === undefined ? [] : [`from=${event.from}`]),
      ...(event.to === undefined ? [] : [`to=${event.to}`]),
      ...(event.set_by === undefined ? [] : [`set_by=${event.set_by}`]),
      ...(event.reason === undefined ? [] : [`reason=${event.reason}`]),
    ];
    lines.push(`  ${event.ts} ${event.event} ${details.join(" ")}`);
  }
  if (skippedMalformedLines > 0) lines.push(`skipped ${skippedMalformedLines} malformed lines`);
  return `${lines.join("\n")}\n`;
}

async function doctorCommand(parsed: ParsedArgs): Promise<number> {
  rejectUnknownOptions(parsed, ["dir", "install", "pack", "hermes-config"]);
  if (parsed.positionals.length !== 0) throw new Error("usage: persona doctor [--dir <directory>]");
  const root = installRoot(parsed);
  const report = await runDoctor({
    installRoot: root,
    engineVersion: ENGINE_VERSION,
    ...(parsed.options.get("install") === undefined ? {} : { installFile: parsed.options.get("install") }),
    ...(parsed.options.get("pack") === undefined ? {} : { packDir: parsed.options.get("pack") }),
    ...(parsed.options.get("hermes-config") === undefined ? {} : { hermesConfig: parsed.options.get("hermes-config") }),
  });
  printJson(report);
  return report.ok ? EXIT_SUCCESS : EXIT_BUILD_ERROR;
}

function usage(): string {
  return "usage: persona <init|build|doctor|turn|report-adapter-error|set|get|list|audit> [options]";
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error(usage());
  const parsed = parseArgs(rest);
  switch (command) {
    case "init": return await initCommand(parsed);
    case "build": return buildCommand(parsed);
    case "doctor": return await doctorCommand(parsed);
    case "turn": return turnCommand(parsed);
    case "report-adapter-error": return reportAdapterErrorCommand(parsed);
    case "set": return setCommand(parsed);
    case "get": return getCommand(parsed);
    case "list": return await listCommand(parsed);
    case "audit": return await auditCommand(parsed);
    default: throw new Error(`${usage()}\nunknown command '${command}'`);
  }
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (error) {
    process.stderr.write(`persona: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CliBuildError ? EXIT_BUILD_ERROR : EXIT_ERROR;
  }
}
