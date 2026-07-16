/** SPEC §7.1 */
export type TurnInput = {
  ctx: Record<string, unknown>;
  utterance?: string;
  actor: "owner" | "unknown";
  turn_key?: string;
};

/** SPEC §7.1 / §7.2 shared rejection shape. */
export type Rejected = {
  requested_mode: string;
  reason: string;
};

/** SPEC §7.1 */
export type TurnResult = {
  mode: string;
  block: string;
  /** `"__default__"` when resolved via `default_route`. */
  route_id: string;
  state_domain: string;
  transitioned: boolean;
  rejected?: Rejected;
  degraded?: boolean;
  audit: AuditEvent[];
};

/** SPEC §8 audit line shape. */
export type AuditEvent = {
  ts: string;
  event: string;
  route_id: string;
  domain: string;
  from?: string;
  to?: string;
  set_by?: "owner" | "agent" | "admin";
  reason?: string;
};

/**
 * SPEC §7.2 — discriminated by actor: the tool path (`agent`) carries trusted
 * ctx and never picks a domain; the CLI path (`admin`) has no ctx and MUST
 * name the domain explicitly (implicit selection is forbidden).
 */
export type SetInput =
  | {
      actor: "agent";
      ctx: Record<string, unknown>;
      requested_mode: string;
    }
  | {
      actor: "admin";
      ctx: null;
      requested_mode: string;
      domain: string;
    };

/** SPEC §7.2 */
export type SetResult = {
  ok: boolean;
  mode: string;
  transitioned: boolean;
  rejected?: Rejected;
  degraded?: boolean;
  audit: AuditEvent[];
};

/** SPEC §7.3 */
export type StateFile = {
  v: number;
  revision: number;
  mode: string;
  set_by: "owner" | "agent" | "admin";
  set_at: string;
  route_id: string;
};

/** SPEC §4 `manifest.json`. */
export type BuildManifest = {
  schema_version: number;
  pack_name: string;
  pack_version: string;
  engine_version: string;
  engine_range: { min: string; max: string | null };
  built_at: string;
  content_hash: string;
  counter: "pe-count-v1";
  modes: Record<
    string,
    {
      bytes: number;
      tokens: number;
      sha256: string;
      voice_hint?: string;
    }
  >;
};

/** SPEC §4 `triggers.json`. */
export type TriggersJson = {
  normalization: 1;
  reserved_prefix: "/persona";
  aliases: Record<string, string>;
};

/** SPEC §4 `policy.json`. §8 requires `audit_dir` baked in at build time; §6.1 default_route only configures `state_domain`. */
export type PolicyJson = {
  routes: RouteDecl[];
  domains: string[];
  modes: string[];
  default_route: {
    state_domain: string;
  };
  /** Install-root-relative, validated at build time (SPEC §8). */
  audit_dir: string;
};

/** SPEC §6.1 */
export type RouteDecl = {
  id: string;
  match: Record<string, MatchSpec>;
  allowed_modes: string[];
  switching: "deny" | "explicit" | "explicit-and-agent";
  state_domain: string;
  /** Defaults to `false` when omitted. */
  owner_verified?: boolean;
};

/** SPEC §6.1 */
export type MatchSpec = string | { prefix: string };

/** SPEC §8 `state/status.json` — atomically rewritten every turn. */
export type StatusJson = {
  ts: string;
  route_id: string;
  mode: string;
  block_sha256: string;
  block_bytes: number;
  /** Implementation id, e.g. `"ts@0.1.0"` or `"py@0.1.0"` (SPEC §11 drift investigation). */
  engine: string;
  turn_key?: string;
};

/** Runtime filesystem and observability dependencies for turn/set. */
export type RuntimeDeps = {
  /** Install root containing build/, state/, and the compiled audit location. */
  installRoot: string;
  /** Running core version. Defaults to the package version. */
  engineVersion?: string;
  /** Test seam for timestamps; production callers should omit it. */
  now?: () => Date;
  /** Host logging seam used when audit/status persistence degrades. */
  warn?: (message: string) => void;
};

/** Operational context for adapter-error reporting; values are never audited. */
export type AdapterErrorContext = Pick<RuntimeDeps, "installRoot"> &
  Partial<Omit<RuntimeDeps, "installRoot">> & {
    route_id?: string;
    domain?: string;
    turn_key?: string;
  };

export type AdapterErrorReport = {
  degraded: boolean;
  audit: AuditEvent[];
};
