import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AuditEvent,
  BuildManifest,
  PolicyJson,
  RouteDecl,
  TriggersJson,
} from "@persona-engine/core";

const MODE_ID = /^[a-z0-9-]+$/u;
const DOMAIN_ID = /^[a-z0-9_-]{1,64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type LoadedBuild = {
  manifest: BuildManifest;
  policy: PolicyJson;
  triggers: TriggersJson;
  blocks: Readonly<Record<string, string>>;
};

export type BuildLoad = {
  loaded: LoadedBuild | null;
  policy: PolicyJson | null;
  reason: string | null;
};

export type RouteResolution = {
  route: RouteDecl;
  route_id: string;
  state_domain: string;
  audit: AuditEvent[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeUtf8(payload: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

function readJson(path: string): unknown {
  return JSON.parse(decodeUtf8(readFileSync(path))) as unknown;
}

const ISO_DATE = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})|(\d{4})-W(\d{2})(?:-(\d))?|(\d{4})W(\d{2})(\d)?)(?:([\s\S])(.+))?$/u;
const ISO_TIME = /^(\d{2})(?:(?::(\d{2})(?::(\d{2}))?|(\d{2})(\d{2})?))?(?:[.,]\d+)?$/u;

function validIsoTime(value: string): boolean {
  const match = ISO_TIME.exec(value);
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? match[4] ?? 0);
  const second = Number(match[3] ?? match[5] ?? 0);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function validIsoOffset(value: string): boolean {
  const match = ISO_TIME.exec(value);
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? match[4] ?? 0);
  const second = Number(match[3] ?? match[5] ?? 0);
  return hour * 3600 + minute * 60 + second < 24 * 3600;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validWeekDate(year: number, week: number, weekday: number): boolean {
  if (year < 1 || week < 1 || week > 53 || weekday < 1 || weekday > 7) return false;
  if (week < 53) return true;
  const januaryFirst = new Date(0);
  januaryFirst.setUTCHours(0, 0, 0, 0);
  januaryFirst.setUTCFullYear(year, 0, 1);
  const day = januaryFirst.getUTCDay();
  return day === 4 || (day === 3 && isLeapYear(year));
}

function parseableIsoDatetime(value: string): boolean {
  const candidate = value.endsWith("Z") ? `${value.slice(0, -1)}+00:00` : value;
  const match = ISO_DATE.exec(candidate);
  if (match === null) return false;
  const weekYear = match[7] ?? match[10];
  const dateValid = weekYear === undefined
    ? validCalendarDate(Number(match[1] ?? match[4]), Number(match[2] ?? match[5]), Number(match[3] ?? match[6]))
    : validWeekDate(Number(weekYear), Number(match[8] ?? match[11]), Number(match[9] ?? match[12] ?? 1));
  if (!dateValid || match[14] === undefined) return dateValid;
  let time = match[14];
  if (time.endsWith("Z")) time = time.slice(0, -1);
  else {
    const plus = time.indexOf("+");
    const minus = time.indexOf("-");
    const offsetAt = plus >= 0 ? plus : minus;
    if (offsetAt >= 0) {
      const offset = time.slice(offsetAt + 1);
      time = time.slice(0, offsetAt);
      if (!validIsoOffset(offset)) return false;
    }
  }
  return validIsoTime(time);
}

function engineCompatible(built: string, running: string): boolean {
  const builtMatch = SEMVER.exec(built);
  const runningMatch = SEMVER.exec(running);
  return builtMatch !== null && runningMatch !== null &&
    builtMatch[1] === runningMatch[1] && builtMatch[2] === runningMatch[2];
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
    (value.switching === "deny" || value.switching === "explicit" || value.switching === "explicit-and-agent") &&
    typeof value.state_domain === "string" &&
    DOMAIN_ID.test(value.state_domain) &&
    (value.owner_verified === undefined || typeof value.owner_verified === "boolean") &&
    (value.switching === "deny" || value.owner_verified === true);
}

function isPolicy(value: unknown): value is PolicyJson {
  if (!(isRecord(value) &&
    Array.isArray(value.routes) && value.routes.every(isRoute) &&
    Array.isArray(value.domains) && value.domains.every((domain) => typeof domain === "string" && DOMAIN_ID.test(domain)) &&
    Array.isArray(value.modes) && value.modes.every((mode) => typeof mode === "string") &&
    isRecord(value.default_route) && typeof value.default_route.state_domain === "string" &&
    typeof value.audit_dir === "string")) return false;

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

function isManifest(value: unknown): value is BuildManifest {
  if (!(isRecord(value) && value.schema_version === 2 &&
    typeof value.pack_name === "string" && MODE_ID.test(value.pack_name) &&
    typeof value.pack_version === "string" && SEMVER.test(value.pack_version) &&
    typeof value.engine_version === "string" && SEMVER.test(value.engine_version) &&
    isRecord(value.engine_range) &&
    typeof value.engine_range.min === "string" && SEMVER.test(value.engine_range.min) &&
    (value.engine_range.max === null || (typeof value.engine_range.max === "string" && SEMVER.test(value.engine_range.max))) &&
    typeof value.built_at === "string" && parseableIsoDatetime(value.built_at) &&
    value.counter === "pe-count-v1" &&
    typeof value.content_hash === "string" && SHA256.test(value.content_hash) &&
    isRecord(value.modes))) return false;

  return Object.entries(value.modes).every(([mode, metadata]) =>
    MODE_ID.test(mode) && isRecord(metadata) &&
    Number.isSafeInteger(metadata.bytes) && (metadata.bytes as number) >= 0 &&
    Number.isSafeInteger(metadata.tokens) && (metadata.tokens as number) >= 0 &&
    typeof metadata.sha256 === "string" && SHA256.test(metadata.sha256) &&
    (metadata.voice_hint === undefined || typeof metadata.voice_hint === "string"),
  );
}

function isTriggers(value: unknown): value is TriggersJson {
  return isRecord(value) && value.normalization === 1 && value.reserved_prefix === "/persona" &&
    isRecord(value.aliases) && Object.values(value.aliases).every((mode) => typeof mode === "string");
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

function readVerifiedBlock(path: string, expectedBytes: number, expectedSha256: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("block is not a regular file");
    const payload = readFileSync(fd);
    const digest = createHash("sha256").update(payload).digest("hex");
    if (payload.byteLength !== expectedBytes || digest !== expectedSha256) {
      throw new Error("block does not match manifest");
    }
    return decodeUtf8(payload);
  } finally {
    closeSync(fd);
  }
}

export function loadBuild(installRoot: string, engineVersion: string): BuildLoad {
  const buildRoot = resolve(installRoot, "build");
  let policyValue: unknown;
  try {
    policyValue = readJson(resolve(buildRoot, "policy.json"));
  } catch {
    return { loaded: null, policy: null, reason: "policy-unavailable" };
  }
  if (!isPolicy(policyValue)) {
    return { loaded: null, policy: null, reason: "policy-invalid" };
  }
  const policy = policyValue;
  let manifestValue: unknown;
  let triggersValue: unknown;
  try {
    manifestValue = readJson(resolve(buildRoot, "manifest.json"));
    triggersValue = readJson(resolve(buildRoot, "triggers.json"));
  } catch {
    return { loaded: null, policy, reason: "build-artifact-unavailable" };
  }
  if (!isManifest(manifestValue) || !engineCompatible(manifestValue.engine_version, engineVersion)) {
    return { loaded: null, policy, reason: "manifest-incompatible" };
  }
  if (!isTriggers(triggersValue)) {
    return { loaded: null, policy, reason: "triggers-incompatible" };
  }
  const manifest = manifestValue;
  const triggers = triggersValue;
  const manifestModes = new Set(Object.keys(manifest.modes));
  const policyModes = new Set(policy.modes.filter((mode) => mode !== "public"));
  if (manifestModes.size !== policyModes.size ||
    [...manifestModes].some((mode) => !policyModes.has(mode)) ||
    Object.values(triggers.aliases).some((mode) => mode !== "public" && !policyModes.has(mode))) {
    return { loaded: null, policy, reason: "build-artifacts-inconsistent" };
  }
  try {
    const blocks = Object.fromEntries(Object.entries(manifest.modes).map(([mode, metadata]) => [
      mode,
      readVerifiedBlock(resolve(buildRoot, "modes", `${mode}.md`), metadata.bytes, metadata.sha256),
    ]));
    return { loaded: { manifest, policy, triggers, blocks }, policy, reason: null };
  } catch {
    return { loaded: null, policy, reason: "block-unavailable" };
  }
}

export function routeMatches(ctx: Record<string, unknown>, route: RouteDecl): boolean {
  return Object.entries(route.match).every(([key, match]) => {
    const value = ctx[key];
    if (typeof value !== "string") return false;
    return typeof match === "string" ? value === match : value.startsWith(match.prefix);
  });
}

export function resolveRoute(
  ctx: Record<string, unknown>,
  policy: PolicyJson,
  timestamp: string,
): RouteResolution {
  const domain = policy.default_route.state_domain;
  const defaultRoute: RouteDecl = {
    id: "__default__",
    match: {},
    allowed_modes: ["public"],
    switching: "deny",
    state_domain: domain,
    owner_verified: false,
  };
  const complete = typeof ctx.session_key_rest === "string" && ctx.session_key_rest.length > 0;
  let matches: RouteDecl[] = [];
  try {
    if (complete) matches = policy.routes.filter((route) => routeMatches(ctx, route));
  } catch {
    matches = [];
  }
  if (matches.length === 1) {
    const route = matches[0] as RouteDecl;
    return { route, route_id: route.id, state_domain: route.state_domain, audit: [] };
  }
  return {
    route: defaultRoute,
    route_id: defaultRoute.id,
    state_domain: domain,
    audit: [{
      ts: timestamp,
      event: "route_unresolved",
      route_id: defaultRoute.id,
      domain,
      ...(matches.length > 1 ? { reason: "overlapping-routes" } : {}),
    }],
  };
}

export function resolveRouteContext(
  ctx: Record<string, unknown>,
  installRoot: string,
  engineVersion = "0.0.0",
): RouteResolution {
  const result = loadBuild(installRoot, engineVersion);
  const effective = result.loaded?.policy ?? result.policy ?? defaultPolicy();
  return resolveRoute(ctx, effective, new Date().toISOString());
}
