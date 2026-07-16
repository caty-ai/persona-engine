import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { engineCompatible, isBuildManifest } from "../build-manifest.js";
import { compilePack } from "../compile/index.js";
import { sha256 } from "../compile/hash.js";
import { parseSafeYaml } from "../compile/yaml.js";
import { isRecord, readJson } from "../json.js";
import { isPolicy, isTriggers } from "../turn/index.js";
import type { BuildManifest, PolicyJson, TriggersJson } from "../types.js";

export type DoctorStatus = {
  present: boolean;
  ts?: string | null;
  age_seconds?: number | null;
};

export type DoctorReport = {
  ok: boolean;
  issues: string[];
  warnings: string[];
  notes: string[];
  status: DoctorStatus;
};

export type DoctorOptions = {
  installRoot: string;
  engineVersion: string;
  installFile?: string;
  packDir?: string;
  hermesConfig?: string;
  env?: NodeJS.ProcessEnv;
};

const GROUP_PLATFORMS = new Set([
  "slack", "telegram", "discord", "whatsapp", "matrix", "mattermost", "line",
  "irc", "feishu", "google_chat", "dingtalk", "qqbot", "email",
]);

const SECRET_PATTERNS = [
  ["OpenAI-style API key", /sk-[A-Za-z0-9]{16,}/u],
  ["Slack bot/app token", /(?:xoxb|xapp)-/u],
  ["AWS access key", /AKIA[0-9A-Z]{16}/u],
  ["GitHub personal access token", /ghp_[A-Za-z0-9]{20,}/u],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["JWT", /eyJ[A-Za-z0-9_-]{20,}\.eyJ/u],
] as const;

const AUDIT_TAIL_BYTES = 1024 * 1024;
const BLOCK_READ_CHUNK_BYTES = 64 * 1024;
const OPENCLAW_BOOTSTRAP_MAX_CHARS = 20_000;
const SESSION_SCOPE_KEYS = ["session_key", "session_id", "channel_id", "session_key_rest"] as const;

function messageWithFix(message: string, fix: string): string {
  return `${message} — fix: ${fix}`;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function buildJsonReadIssue(file: string, error: unknown): string {
  if (error instanceof SyntaxError) return `${file} is not valid JSON`;
  if (errorCode(error) === "ENOENT") return `${file} is missing`;
  return `${file} is unreadable`;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolvePack(options: DoctorOptions): { installFile: string; packDir: string } {
  const installFile = resolve(options.installFile ?? resolve(options.installRoot, "install.yml"));
  if (options.packDir !== undefined) return { installFile, packDir: resolve(options.packDir) };
  const install = parseSafeYaml(readFileSync(installFile, "utf8"));
  if (!isRecord(install) || typeof install.pack !== "string" || install.pack.length === 0) {
    throw new Error("install.yml must contain a local pack path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(install.pack)) {
    throw new Error("remote pack URLs are not supported by this M1 CLI");
  }
  return { installFile, packDir: resolve(dirname(installFile), install.pack) };
}

function readInstallRuntime(options: DoctorOptions): string | undefined {
  const installFile = resolve(options.installFile ?? resolve(options.installRoot, "install.yml"));
  try {
    const install = parseSafeYaml(readFileSync(installFile, "utf8"));
    return isRecord(install) && typeof install.runtime === "string" ? install.runtime : undefined;
  } catch {
    return undefined;
  }
}

async function readPolicy(root: string, issues: string[]): Promise<PolicyJson | undefined> {
  let value: unknown;
  try {
    value = await readJson(resolve(root, "build", "policy.json"));
  } catch (error) {
    issues.push(messageWithFix(
      buildJsonReadIssue("build/policy.json", error),
      "rebuild with persona build",
    ));
    return undefined;
  }
  if (!isPolicy(value)) {
    issues.push(messageWithFix(
      "build/policy.json cannot be checked: artifact does not match the runtime schema",
      "rebuild with persona build",
    ));
    return undefined;
  }
  return value;
}

async function readTriggers(root: string, issues: string[]): Promise<TriggersJson | undefined> {
  let value: unknown;
  try {
    value = await readJson(resolve(root, "build", "triggers.json"));
  } catch (error) {
    issues.push(messageWithFix(
      buildJsonReadIssue("build/triggers.json", error),
      "rebuild with persona build",
    ));
    return undefined;
  }
  if (!isTriggers(value)) {
    issues.push(messageWithFix(
      "build/triggers.json cannot be checked: artifact does not match the runtime schema",
      "rebuild with persona build",
    ));
    return undefined;
  }
  return value;
}

function inspectStatus(root: string, issues: string[], notes: string[]): DoctorStatus {
  const statusPath = resolve(root, "state", "status.json");
  if (!existsSync(statusPath)) {
    notes.push("state/status.json is absent; freshness is unavailable — fix: run a persona turn and rerun persona doctor");
    return { present: false };
  }
  try {
    const value = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
    const ts = isRecord(value) && typeof value.ts === "string" ? value.ts : undefined;
    const validTimestamp = ts !== undefined && Number.isFinite(Date.parse(ts));
    const status = {
      present: true,
      ts: ts ?? null,
      age_seconds: validTimestamp
        ? Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1_000))
        : null,
    };
    if (!validTimestamp) {
      issues.push(messageWithFix(
        "state/status.json has an invalid timestamp",
        "run a successful persona turn to regenerate state/status.json",
      ));
    }
    notes.push(`state/status.json freshness: age_seconds=${String(status.age_seconds)} — fix: run a persona turn if this age is unexpected`);
    return status;
  } catch {
    issues.push(messageWithFix(
      "state/status.json is not valid JSON",
      "run a successful persona turn to regenerate state/status.json",
    ));
    notes.push("state/status.json freshness: age_seconds=null — fix: regenerate state/status.json with a successful persona turn");
    return { present: true, ts: null, age_seconds: null };
  }
}

function safeInstallRelative(root: string, value: string): string | undefined {
  if (value.length === 0 || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value)) {
    return undefined;
  }
  const parts = value.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  const target = resolve(root, ...parts);
  return contained(resolve(root), target) ? target : undefined;
}

export async function resolveAuditRoot(root: string, value: string): Promise<string> {
  const target = safeInstallRelative(root, value);
  if (target === undefined) throw new Error("compiled audit directory is unsafe");

  const rootReal = await realpath(root);
  const parts = value.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    const candidate = resolve(current, part);
    try {
      await lstat(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const missingTarget = resolve(current, ...parts.slice(index));
      if (!contained(rootReal, missingTarget)) throw new Error("compiled audit directory escapes install root");
      return missingTarget;
    }
    try {
      current = await realpath(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error("audit_dir is a dangling symlink");
      throw error;
    }
    if (!contained(rootReal, current)) throw new Error("compiled audit directory escapes install root");
  }
  if (!(await lstat(current)).isDirectory()) throw new Error("audit_dir is not a directory");
  return current;
}

export async function readAuditTail(auditPath: string): Promise<{
  lines: string[];
  partialLastLine: boolean;
  bytesRead: number;
}> {
  const handle = await open(auditPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("audit.jsonl is not a regular file");
    const hasPrefix = metadata.size > AUDIT_TAIL_BYTES;
    const probeBytes = hasPrefix ? 1 : 0;
    const length = Math.min(metadata.size, AUDIT_TAIL_BYTES - probeBytes);
    const position = metadata.size - length;
    const buffer = Buffer.alloc(length);
    let totalBytesRead = 0;
    while (totalBytesRead < length) {
      const result = await handle.read(
        buffer,
        totalBytesRead,
        length - totalBytesRead,
        position + totalBytesRead,
      );
      if (result.bytesRead === 0) break;
      totalBytesRead += result.bytesRead;
    }
    const physicalLines = buffer.subarray(0, totalBytesRead).toString("utf8").split(/\r?\n/u);
    let precedingBytesRead = 0;
    if (hasPrefix && position > 0) {
      const precedingByte = Buffer.alloc(1);
      const result = await handle.read(precedingByte, 0, 1, position - 1);
      precedingBytesRead = result.bytesRead;
      if (result.bytesRead === 1 && precedingByte[0] !== 0x0a) physicalLines.shift();
    }
    const partialLastLine = totalBytesRead > 0 && physicalLines.at(-1) !== "";
    if (physicalLines.at(-1) === "" || partialLastLine) physicalLines.pop();
    return {
      lines: physicalLines.slice(-500),
      partialLastLine,
      bytesRead: totalBytesRead + precedingBytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function inspectAudit(
  root: string,
  policy: PolicyJson | undefined,
  issues: string[],
  warnings: string[],
  notes: string[],
): Promise<void> {
  const auditDir = policy?.audit_dir ?? "audit/";
  let auditRoot: string;
  try {
    auditRoot = await resolveAuditRoot(root, typeof auditDir === "string" ? auditDir : "audit/");
  } catch (error) {
    const detail = error instanceof Error && [
      "audit_dir is a dangling symlink",
      "audit_dir is not a directory",
      "compiled audit directory escapes install root",
    ].includes(error.message) ? error.message : undefined;
    if (detail === "audit_dir is a dangling symlink") {
      issues.push(messageWithFix(detail, "recreate the audit directory"));
    } else if (detail === "audit_dir is not a directory") {
      issues.push(messageWithFix(detail, "rebuild or remove the file"));
    } else if (detail === "compiled audit directory escapes install root") {
      issues.push(messageWithFix(
        "compiled audit directory is unsafe and audit.jsonl was not read: compiled audit directory escapes install root",
        "set audit.dir to an install-relative path without '..' and rerun persona build",
      ));
    } else {
      issues.push(messageWithFix(
        "compiled audit directory is unsafe and audit.jsonl was not read",
        "set audit.dir to an install-relative path without '..' and rerun persona build",
      ));
    }
    notes.push("audit sample: valid_events=0, failure_events=0, malformed_lines=0, failure_share=0 — fix: repair audit.dir before interpreting these counts");
    return;
  }
  const auditPath = resolve(auditRoot, "audit.jsonl");
  if (!existsSync(auditPath)) {
    notes.push("audit sample: valid_events=0, failure_events=0, malformed_lines=0, failure_share=0 (audit.jsonl absent) — fix: run instrumented persona turns to create audit data");
    return;
  }

  let lines: string[];
  let partialLastLine = false;
  try {
    ({ lines, partialLastLine } = await readAuditTail(auditPath));
  } catch {
    warnings.push(messageWithFix(
      "audit.jsonl cannot be read",
      "repair audit file permissions and rerun persona doctor",
    ));
    notes.push("audit sample: valid_events=0, failure_events=0, malformed_lines=0, failure_share=0 — fix: make audit.jsonl readable before interpreting these counts");
    return;
  }

  if (partialLastLine) notes.push("last audit line appears mid-write");

  let valid = 0;
  let failures = 0;
  let malformed = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event) || typeof event.event !== "string") throw new Error("invalid event");
      valid += 1;
      if (event.event === "route_unresolved" || event.event === "resolve_downgrade" ||
          event.event.startsWith("adapter_error")) failures += 1;
    } catch {
      malformed += 1;
    }
  }
  const share = valid === 0 ? 0 : failures / valid;
  notes.push(`audit sample: valid_events=${valid}, failure_events=${failures}, malformed_lines=${malformed}, failure_share=${share.toFixed(3)} — fix: inspect audit.jsonl when failure or malformed counts are nonzero`);
  if (malformed > 0) {
    warnings.push(messageWithFix(
      `audit.jsonl contains ${malformed} malformed line(s) in the last ${lines.length} sampled line(s)`,
      "remove or repair malformed JSONL records and preserve one JSON object per line",
    ));
  }
  if (valid >= 10 && share > 0.2) {
    warnings.push(messageWithFix(
      `audit failure-event share is ${share.toFixed(3)} (${failures}/${valid}) over the recent sample`,
      "inspect route resolution, downgrade, and adapter errors in audit.jsonl",
    ));
  }
}

function inspectOpenClaw(runtime: string | undefined, notes: string[]): void {
  if (runtime !== "openclaw") return;
  notes.push("OpenClaw prompt-injection hook is not checkable without host config — fix: verify plugins.entries.<id>.hooks.allowPromptInjection !== false in the OpenClaw config");
  notes.push("OpenClaw voice-route prefix hook reachability is not checkable without host config — fix: verify the installed agent CLI supports the required session-key routing and test the voice route end to end");
  notes.push("OpenClaw tool-name collisions are not checkable without host diagnostics — fix: inspect OpenClaw plugin diagnostics for persona-engine tool-name conflicts");
}

function hermesPaths(options: DoctorOptions): { profile: string; config: string; sessions: string } | undefined {
  if (options.hermesConfig !== undefined) {
    const config = resolve(options.hermesConfig);
    const profile = dirname(config);
    return { profile, config, sessions: resolve(profile, "sessions", "sessions.json") };
  }
  const rawSessions = (options.env ?? process.env).PERSONA_ENGINE_SESSIONS_FILE;
  if (rawSessions === undefined || rawSessions.length === 0) return undefined;
  const sessions = resolve(rawSessions);
  const profile = dirname(dirname(sessions));
  if (sessions !== resolve(profile, "sessions", "sessions.json") || !contained(profile, sessions)) return undefined;
  return { profile, config: resolve(profile, "config.yaml"), sessions };
}

type CanonicalTarget = { path: string; danglingSymlink: boolean };

async function canonicalTarget(path: string, seen = new Set<string>()): Promise<CanonicalTarget> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return { path: resolve(await realpath(current), ...suffix), danglingSymlink: false };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          if (seen.has(current)) throw new Error("symlink cycle cannot be canonicalized");
          const nextSeen = new Set(seen).add(current);
          const target = resolve(dirname(current), await readlink(current));
          const canonical = await canonicalTarget(target, nextSeen);
          return {
            path: resolve(canonical.path, ...suffix),
            danglingSymlink: true,
          };
        }
      } catch (lstatError) {
        if (errorCode(lstatError) !== "ENOENT") throw lstatError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function inspectHermes(
  runtime: string | undefined,
  options: DoctorOptions,
  warnings: string[],
  notes: string[],
): Promise<void> {
  if (runtime !== "hermes") return;
  const paths = hermesPaths(options);
  if (paths === undefined) {
    notes.push("Hermes host checks were skipped because no safe profile location was available — fix: pass --hermes-config <profile/config.yaml> or set PERSONA_ENGINE_SESSIONS_FILE=<profile>/sessions/sessions.json");
    return;
  }
  const expected = [
    paths.config,
    resolve(paths.profile, "plugins", "persona-engine", "plugin.yaml"),
    resolve(paths.profile, "plugins", "persona-engine", "__init__.py"),
    paths.sessions,
  ];
  let canonicalProfile: string;
  let canonicalExpected: CanonicalTarget[];
  try {
    canonicalProfile = (await canonicalTarget(paths.profile)).path;
    canonicalExpected = await Promise.all(expected.map((path) => canonicalTarget(path)));
  } catch {
    warnings.push(messageWithFix(
      "Hermes profile paths cannot be canonicalized safely",
      "use readable canonical profile paths and rerun persona doctor",
    ));
    return;
  }
  const canonicalSessions = canonicalExpected[3];
  if (canonicalSessions !== undefined && !contained(canonicalProfile, canonicalSessions.path)) {
    warnings.push(messageWithFix(
      `sessions path escapes the profile root (${canonicalSessions.danglingSymlink ? "dangling symlink" : "symlink"})`,
      "point persona_engine_sessions_file at the real profile sessions.json",
    ));
    return;
  }
  if (canonicalExpected.slice(0, 3).some((target) => !contained(canonicalProfile, target.path))) {
    warnings.push(messageWithFix(
      "Hermes profile paths escape the resolved profile root",
      "use canonical plugin and config paths under one profile directory",
    ));
    return;
  }

  let configSource: string | undefined;
  try {
    configSource = readFileSync(paths.config, "utf8");
  } catch {
    warnings.push(messageWithFix(
      "Hermes profile config.yaml cannot be read",
      "create a readable safe-YAML profile config.yaml with plugins.enabled containing persona-engine",
    ));
    configSource = undefined;
  }
  if (configSource !== undefined) try {
    const config = parseSafeYaml(configSource);
    const plugins = isRecord(config) && isRecord(config.plugins) ? config.plugins : undefined;
    if (!Array.isArray(plugins?.enabled) || !plugins.enabled.includes("persona-engine")) {
      warnings.push(messageWithFix(
        "Hermes profile config does not enable persona-engine",
        "add persona-engine to plugins.enabled in the profile config.yaml",
      ));
    }
  } catch {
    warnings.push(messageWithFix(
      "Hermes profile config.yaml cannot be parsed as YAML",
      "create a readable safe-YAML profile config.yaml with plugins.enabled containing persona-engine",
    ));
  }

  for (const [label, path] of [
    ["plugin.yaml", expected[1]],
    ["__init__.py", expected[2]],
  ] as const) {
    if (path === undefined || !existsSync(path) || !statSync(path).isFile()) {
      warnings.push(messageWithFix(
        `Hermes persona-engine ${label} is missing`,
        `install ${label} under <profile>/plugins/persona-engine/`,
      ));
    }
  }

  let sessionsSource: string;
  try {
    sessionsSource = readFileSync(paths.sessions, "utf8");
  } catch {
    warnings.push(messageWithFix(
      "Hermes sessions.json is missing or unreadable",
      "create a readable <profile>/sessions/sessions.json whose top level is an object",
    ));
    return;
  }
  try {
    const sessions = JSON.parse(sessionsSource) as unknown;
    if (!isRecord(sessions)) throw new Error("top-level value is not an object");
  } catch {
    warnings.push(messageWithFix(
      "Hermes sessions.json is not valid JSON",
      "create a readable <profile>/sessions/sessions.json whose top level is an object",
    ));
  }
}

function inspectRoutes(
  runtime: string | undefined,
  policy: PolicyJson | undefined,
  triggers: TriggersJson | undefined,
  warnings: string[],
  notes: string[],
): void {
  const routes = policy?.routes ?? [];
  for (const route of routes) {
    const platform = route.match.platform;
    const hasSessionScope = SESSION_SCOPE_KEYS.some((key) => {
      const match = route.match[key];
      return typeof match === "string"
        ? match.length > 0
        : isRecord(match) && typeof match.prefix === "string" && match.prefix.length > 0;
    });
    if (route.owner_verified === true && typeof platform === "string" &&
        GROUP_PLATFORMS.has(platform) && !hasSessionScope) {
      warnings.push(messageWithFix(
        `route '${route.id}' owner-verifies a bare ${platform} platform match; SPEC §6.1 requires group-capable routes to degrade safely`,
        "add a conversation/session-scoping match key or set owner_verified: false and switching: deny",
      ));
    }
    if (runtime === "hermes" && platform === "api_server" && route.match.session_key !== undefined) {
      warnings.push(messageWithFix(
        `route '${route.id}' matches session_key on api_server and is dead per the measured Hermes mapping`,
        "match on platform: api_server instead because session_key never reaches llm_request middleware",
      ));
    }
  }

  for (const alias of Object.keys(triggers?.aliases ?? {})) {
    if (alias.includes("{{")) {
      warnings.push(messageWithFix(
        `alias key '${alias}' contains an unresolved placeholder and is dead (Issue #53)`,
        "replace the placeholder with a concrete normalized alias and rerun persona build",
      ));
    }
  }

  if (routes.some((route) => route.allowed_modes.some((mode) => mode !== "public"))) {
    warnings.push(messageWithFix(
      "host shared-memory settings may leak private-mode context across surfaces; v2 warns only (design §2.7)",
      "review host memory scoping, for example per-profile container tags",
    ));
  }

  if (runtime === "hermes" && routes.some((route) => route.match.platform === "api_server")) {
    notes.push("Hermes measured mapping: conversation→session_id is an opaque stable per-conversation UUID and session_key never reaches llm_request middleware (measured 2026-07-12, Issue #24) — fix: use platform/session_id matches that reflect this host boundary");
  }
  if (routes.some((route) => route.owner_verified === true &&
      (route.match.platform === "api_server" ||
       (isRecord(route.match.session_key) && typeof route.match.session_key.prefix === "string")))) {
    notes.push("SPEC §6.2 trust boundary: api_server or session_key-prefix owner promotion depends on host-supplied identity and routing context — fix: verify the host trust boundary before treating the route as owner-verified");
  }
}

type BlockReadResult =
  | { status: "ok"; bytes: Buffer }
  | { status: "symlink" | "not-regular" | "unreadable" };

function readBuildBlock(path: string): BlockReadResult {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return { status: errorCode(error) === "ELOOP" ? "symlink" : "unreadable" };
  }

  try {
    if (!fstatSync(descriptor).isFile()) return { status: "not-regular" };
    const chunks: Buffer[] = [];
    while (true) {
      const chunk = Buffer.allocUnsafe(BLOCK_READ_CHUNK_BYTES);
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { status: "ok", bytes: Buffer.concat(chunks) };
  } catch {
    return { status: "unreadable" };
  } finally {
    closeSync(descriptor);
  }
}

function reportBlockReadIssue(modeId: string, result: BlockReadResult, issues: string[]): void {
  if (result.status === "ok") return;
  if (result.status === "symlink") {
    issues.push(messageWithFix(
      `block '${modeId}' is a symlink; the runtime refuses symlinked blocks (O_NOFOLLOW)`,
      "replace with a regular file / rebuild",
    ));
  } else if (result.status === "not-regular") {
    issues.push(messageWithFix(
      `block '${modeId}' is not a regular file`,
      "rebuild",
    ));
  } else {
    issues.push(messageWithFix(
      `block '${modeId}' disappeared or became unreadable during scan`,
      "rebuild and re-run persona doctor",
    ));
  }
}

function inspectBlocks(
  runtime: string | undefined,
  manifest: BuildManifest | undefined,
  blockReads: ReadonlyMap<string, BlockReadResult>,
  warnings: string[],
): void {
  for (const modeId of Object.keys(manifest?.modes ?? {})) {
    const result = blockReads.get(modeId);
    if (result?.status !== "ok") continue;
    const contents = result.bytes.toString("utf8");
    if (runtime === "openclaw" && contents.length > OPENCLAW_BOOTSTRAP_MAX_CHARS) {
      warnings.push(messageWithFix(
        `compiled mode '${modeId}' has ${contents.length} characters, exceeding the OpenClaw bootstrapMaxChars cap of 20000 characters per file documented in docs/design-v2-proposal.md:139`,
        "reduce the compiled mode block below the documented cap and rerun persona build",
      ));
    }
    for (const [kind, pattern] of SECRET_PATTERNS) {
      if (pattern.test(contents)) {
        warnings.push(messageWithFix(
          `secret pattern '${kind}' detected in mode '${modeId}'`,
          `remove the secret from build/modes/${modeId}.md, rotate the credential, and rebuild from sanitized inputs`,
        ));
      }
    }
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const root = resolve(options.installRoot);
  const issues: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const policy = await readPolicy(root, issues);
  const triggers = await readTriggers(root, issues);
  const blockReads = new Map<string, BlockReadResult>();
  let manifestValue: unknown;
  let manifestRead = false;
  try {
    manifestValue = await readJson(resolve(root, "build", "manifest.json"));
    manifestRead = true;
  } catch (error) {
    issues.push(messageWithFix(
      buildJsonReadIssue("build/manifest.json", error),
      "rebuild with persona build",
    ));
  }
  if (!manifestRead) {
    // The read failure above is the only useful manifest diagnostic.
  } else if (!isBuildManifest(manifestValue)) {
    issues.push(messageWithFix(
      "build/manifest.json does not match schema version 2",
      "rebuild with a schema-v2-compatible persona engine",
    ));
  } else {
    if (!engineCompatible(manifestValue.engine_version, options.engineVersion)) {
      issues.push(messageWithFix(
        `build engine ${manifestValue.engine_version} is incompatible with CLI engine ${options.engineVersion}`,
        "rebuild with the current CLI or use a CLI compatible with the build engine",
      ));
    }
    for (const [mode, rawMetadata] of Object.entries(manifestValue.modes)) {
      if (!isRecord(rawMetadata)) {
        issues.push(messageWithFix(`manifest mode '${mode}' metadata is invalid`, "run persona build to regenerate manifest metadata"));
        continue;
      }
      const path = resolve(root, "build", "modes", `${mode}.md`);
      const blockRead = readBuildBlock(path);
      blockReads.set(mode, blockRead);
      reportBlockReadIssue(mode, blockRead, issues);
      if (blockRead.status !== "ok") {
        continue;
      }
      const bytes = blockRead.bytes;
      if (rawMetadata.bytes !== bytes.byteLength) {
        issues.push(messageWithFix(`build block '${mode}' byte count differs from manifest`, "run persona build to regenerate consistent artifacts"));
      }
      if (rawMetadata.tokens !== Math.ceil(bytes.byteLength / 3)) {
        issues.push(messageWithFix(`build block '${mode}' token count differs from pe-count-v1`, "run persona build to recount and regenerate artifacts"));
      }
      if (rawMetadata.sha256 !== sha256(bytes)) {
        issues.push(messageWithFix(`build block '${mode}' sha256 differs from manifest`, "restore the compiled block or rerun persona build"));
      }
    }

    try {
      const paths = resolvePack(options);
      const compiled = compilePack({ ...paths, engineVersion: options.engineVersion });
      if (!compiled.ok) {
        issues.push(...compiled.errors.map((error) => messageWithFix(
          `${error.code}: pack input validation failed`,
          "repair the reported pack input and rerun persona build",
        )));
      } else if (compiled.artifacts.manifest.content_hash !== manifestValue.content_hash) {
        issues.push(messageWithFix(
          "build content_hash does not match current pack inputs",
          "run persona build to compile the current pack inputs",
        ));
      }
      if (compiled.ok) {
        const modeIds = new Set([
          ...Object.keys(compiled.artifacts.manifest.modes),
          ...Object.keys(manifestValue.modes),
        ]);
        for (const modeId of modeIds) {
          const builtPath = resolve(root, "build", "modes", `${modeId}.md`);
          const blockRead = blockReads.get(modeId) ?? readBuildBlock(builtPath);
          blockReads.set(modeId, blockRead);
          const blockMatches = blockRead.status === "ok" &&
            blockRead.bytes.toString("utf8") === compiled.artifacts.modes[modeId];
          if (!isDeepStrictEqual(
            manifestValue.modes[modeId],
            compiled.artifacts.manifest.modes[modeId],
          ) || !blockMatches) {
            issues.push(messageWithFix(
              `build block '${modeId}' does not match current pack+install inputs (post-build modification?)`,
              "rebuild with `persona build`",
            ));
          }
        }
      }
      if (compiled.ok && policy !== undefined &&
          !isDeepStrictEqual(compiled.artifacts.policy, policy)) {
        issues.push(messageWithFix(
          "build/policy.json does not match current pack+install inputs (post-build modification?)",
          "rebuild with `persona build`",
        ));
      }
      if (compiled.ok && triggers !== undefined &&
          !isDeepStrictEqual(compiled.artifacts.triggers, triggers)) {
        issues.push(messageWithFix(
          "build/triggers.json does not match current pack+install inputs (post-build modification?)",
          "rebuild with `persona build`",
        ));
      }
    } catch {
      issues.push(messageWithFix(
        "pack inputs cannot be checked safely",
        "repair install.yml/pack paths or pass --install and --pack explicitly",
      ));
    }
  }

  const status = inspectStatus(root, issues, notes);
  await inspectAudit(root, policy, issues, warnings, notes);
  const runtime = readInstallRuntime(options);
  inspectOpenClaw(runtime, notes);
  await inspectHermes(runtime, options, warnings, notes);
  inspectRoutes(runtime, policy, triggers, warnings, notes);
  inspectBlocks(runtime, isBuildManifest(manifestValue) ? manifestValue : undefined, blockReads, warnings);

  return { ok: issues.length === 0, issues, warnings, notes, status };
}
