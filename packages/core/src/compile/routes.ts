import type { MatchSpec, RouteDecl } from "../types.js";

export const RUNTIME_MATCH_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  openclaw: new Set(["session_key_rest", "channel_id"]),
  hermes: new Set(["platform", "session_id", "session_key", "api_mode"]),
  "claude-code": new Set(),
  generic: new Set(),
};

export function isMatchSpec(value: unknown): value is MatchSpec {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === "prefix" && typeof entries[0][1] === "string";
}

function intersects(left: MatchSpec | undefined, right: MatchSpec | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  if (typeof left === "string" && typeof right === "string") return left === right;
  if (typeof left === "string") return left.startsWith((right as { prefix: string }).prefix);
  if (typeof right === "string") return right.startsWith(left.prefix);
  return left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix);
}

/** The deliberately conservative sole-match overlap rule from SPEC §6.1. */
export function routesOverlap(
  left: Pick<RouteDecl, "match">,
  right: Pick<RouteDecl, "match">,
): boolean {
  const keys = new Set([...Object.keys(left.match), ...Object.keys(right.match)]);
  for (const key of keys) {
    if (!intersects(left.match[key], right.match[key])) return false;
  }
  return true;
}
