import { createHash } from "node:crypto";

import {
  report_adapter_error,
  set as setMode,
  turn,
  type SetResult,
  type TurnResult,
} from "@persona-engine/core";
import { Type, type Static } from "@sinclair/typebox";

import type {
  AgentTool,
  BeforePromptBuildEvent,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginHookAgentContext,
} from "./openclaw-types.js";
import { routeContextFromHook, routeContextFromTool } from "./route-context.js";
import { resolveRouteContext, type RouteResolution } from "./route-resolution.js";

export const ENGINE_VERSION = "0.0.0";
const TURN_CACHE_LIMIT = 1024;
const SESSION_CACHE_LIMIT = 256;
const RESOLUTION_FLIGHT_LIMIT = 512;
const MODE_ID = /^[a-z0-9-]+$/u;
const MODE_ID_MAX_LENGTH = 64;
const PERSONA_SET_REJECTION = "persona_set rejected: mode not allowed on this route";
const FLIGHT_LIMIT_CATEGORY = "flight_limit";

class FlightLimitError extends Error {
  constructor() {
    super("persona: resolution flight limit reached");
    this.name = FLIGHT_LIMIT_CATEGORY;
  }
}

export const PERSONA_SET_PARAMETERS = Type.Object({
  mode: Type.String({ pattern: "^[a-z0-9-]+$", maxLength: MODE_ID_MAX_LENGTH }),
}, { additionalProperties: false });

type Core = {
  turn: typeof turn;
  set: typeof setMode;
  reportAdapterError: typeof report_adapter_error;
};

type CacheKind = "turn" | "session";
type CacheKey = { kind: CacheKind; identifier: string; serialized: string };
type CacheEntry = { result: TurnResult; requestFingerprint: string };

const defaultCore: Core = {
  turn,
  set: setMode,
  reportAdapterError: report_adapter_error,
};

function configuredInstallRoot(api: OpenClawPluginApi): string {
  const configured = api.pluginConfig?.installRoot;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return process.env.PERSONA_ENGINE_INSTALL_ROOT ?? "";
}

function cacheKey(kind: CacheKind, identifier: string): CacheKey {
  return { kind, identifier, serialized: `${kind}:${identifier}` };
}

function rawRouteInputs(ctx: PluginHookAgentContext): string {
  return JSON.stringify([
    [typeof ctx.sessionKey, ctx.sessionKey],
    [typeof ctx.channelId, ctx.channelId],
  ]);
}

function cacheIdentifier(identifier: string, ctx: PluginHookAgentContext): string {
  return JSON.stringify([identifier, rawRouteInputs(ctx)]);
}

function requestFingerprint(event: BeforePromptBuildEvent, ctx: PluginHookAgentContext): string {
  let messages: string;
  try {
    messages = JSON.stringify(event.messages);
  } catch {
    messages = "[unserializable]";
  }
  const contentHash = createHash("sha256")
    .update(event.prompt)
    .update("\0")
    .update(messages)
    .digest("hex");
  return JSON.stringify([rawRouteInputs(ctx), contentHash]);
}

export class OpenClawAdapter {
  readonly installRoot: string;
  private readonly core: Core;
  private readonly warn: (message: string) => void;
  private readonly turnCache = new Map<string, CacheEntry>();
  private readonly sessionCache = new Map<string, CacheEntry>();
  private readonly cacheGenerations = new Map<string, number>();
  private readonly domainKeys = new Map<string, Set<string>>();
  private readonly inflightKeys = new Map<string, number>();
  private readonly resolutionFlights = new Map<string, Promise<TurnResult>>();

  constructor(
    installRoot: string,
    warn: (message: string) => void,
    core: Core = defaultCore,
  ) {
    this.installRoot = installRoot;
    this.warn = warn;
    this.core = core;
  }

  private resolution(routeCtx: Record<string, unknown>): RouteResolution {
    return resolveRouteContext(routeCtx, this.installRoot, ENGINE_VERSION);
  }

  private async report(
    error: unknown,
    routeCtx: Record<string, unknown>,
    turnKey?: string,
  ): Promise<void> {
    const base = {
      installRoot: this.installRoot,
      engineVersion: ENGINE_VERSION,
      ...(turnKey === undefined ? {} : { turn_key: turnKey }),
      warn: this.warn,
    };
    let route: Pick<RouteResolution, "route_id" | "state_domain"> | undefined;
    try {
      route = this.resolution(routeCtx);
    } catch {
      // The original exception can itself be route resolution. Report with
      // the remaining trusted context instead of suppressing that failure.
    }
    try {
      const reportContext = {
        ...base,
        ...(route === undefined ? {} : { route_id: route.route_id, domain: route.state_domain }),
      };
      await this.core.reportAdapterError(error, reportContext);
    } catch {
      try {
        this.warn("persona: failed to report adapter error");
      } catch {
        // Host logging is best-effort and must never escape the adapter.
      }
    }
  }

  private cacheKeys(ctx: PluginHookAgentContext): CacheKey[] {
    const keys: CacheKey[] = [];
    const sessionId = typeof ctx.sessionId === "string" && ctx.sessionId.length > 0
      ? ctx.sessionId
      : typeof ctx.sessionKey === "string" && ctx.sessionKey.length > 0 ? ctx.sessionKey : undefined;
    // This OpenClaw release can reuse runId across distinct utterances, so
    // session identity is authoritative. runId is used only when no session
    // identity exists, so it can never mask session generation invalidation.
    if (sessionId !== undefined) keys.push(cacheKey("session", cacheIdentifier(sessionId, ctx)));
    else if (typeof ctx.runId === "string" && ctx.runId.length > 0) {
      keys.push(cacheKey("turn", cacheIdentifier(ctx.runId, ctx)));
    }
    return keys;
  }

  private cached(keys: CacheKey[], fingerprint: string): TurnResult | undefined {
    for (const key of keys) {
      const cache = key.kind === "turn" ? this.turnCache : this.sessionCache;
      const entry = cache.get(key.identifier);
      if (entry?.requestFingerprint !== fingerprint) continue;
      cache.delete(key.identifier);
      cache.set(key.identifier, entry);
      return entry.result;
    }
    return undefined;
  }

  private generationSnapshot(keys: CacheKey[], domain: string): Map<string, number> {
    const snapshot = new Map<string, number>();
    for (const key of keys) {
      if (key.kind === "session") {
        const domainSet = this.domainKeys.get(domain) ?? new Set<string>();
        domainSet.add(key.serialized);
        this.domainKeys.set(domain, domainSet);
      }
      this.inflightKeys.set(key.serialized, (this.inflightKeys.get(key.serialized) ?? 0) + 1);
      snapshot.set(key.serialized, this.cacheGenerations.get(key.serialized) ?? 0);
    }
    return snapshot;
  }

  private pruneTracking(key: CacheKey): void {
    const cache = key.kind === "turn" ? this.turnCache : this.sessionCache;
    if (this.inflightKeys.has(key.serialized) || cache.has(key.identifier)) return;
    this.cacheGenerations.delete(key.serialized);
    if (key.kind !== "session") return;
    for (const [domain, keys] of this.domainKeys) {
      keys.delete(key.serialized);
      if (keys.size === 0) this.domainKeys.delete(domain);
    }
  }

  private releaseGenerations(keys: CacheKey[]): void {
    for (const key of keys) {
      const remaining = (this.inflightKeys.get(key.serialized) ?? 0) - 1;
      if (remaining > 0) this.inflightKeys.set(key.serialized, remaining);
      else this.inflightKeys.delete(key.serialized);
      this.pruneTracking(key);
    }
  }

  private cachePut(
    keys: CacheKey[],
    result: TurnResult,
    fingerprint: string,
    generations: Map<string, number>,
  ): void {
    const evicted: CacheKey[] = [];
    for (const key of keys) {
      if (key.kind === "session" && result.transitioned) continue;
      if ((this.cacheGenerations.get(key.serialized) ?? 0) !== generations.get(key.serialized)) continue;
      const cache = key.kind === "turn" ? this.turnCache : this.sessionCache;
      cache.delete(key.identifier);
      const entry = { result, requestFingerprint: fingerprint };
      cache.set(key.identifier, entry);
      // OpenClaw exposes no trustworthy logical-turn boundary. Retain a
      // completed value only through the current microtask checkpoint; the
      // separate resolutionFlights map handles pending concurrent delivery.
      queueMicrotask(() => {
        if (cache.get(key.identifier) !== entry) return;
        cache.delete(key.identifier);
        this.pruneTracking(key);
      });
    }
    for (const [kind, cache, limit] of [
      ["turn", this.turnCache, TURN_CACHE_LIMIT],
      ["session", this.sessionCache, SESSION_CACHE_LIMIT],
    ] as const) {
      while (cache.size > limit) {
        const identifier = [...cache.keys()].find((candidate) =>
          !this.inflightKeys.has(cacheKey(kind, candidate).serialized)
        );
        if (identifier === undefined) break;
        cache.delete(identifier);
        evicted.push(cacheKey(kind, identifier));
      }
    }
    for (const key of evicted) this.pruneTracking(key);
  }

  private invalidateSessionDomain(domain: string): void {
    const keys = new Set(this.domainKeys.get(domain) ?? []);
    for (const [identifier, entry] of this.sessionCache) {
      if (entry.result.state_domain === domain) keys.add(cacheKey("session", identifier).serialized);
    }
    for (const serialized of keys) {
      const identifier = serialized.slice("session:".length);
      this.cacheGenerations.set(serialized, (this.cacheGenerations.get(serialized) ?? 0) + 1);
      this.sessionCache.delete(identifier);
      this.pruneTracking(cacheKey("session", identifier));
    }
  }

  private async resolveTurn(
    keys: CacheKey[],
    domain: string,
    fingerprint: string,
    compute: () => Promise<TurnResult>,
  ): Promise<TurnResult> {
    const cached = this.cached(keys, fingerprint);
    if (cached !== undefined) return cached;
    if (keys.length === 0) return compute();
    const primary = keys[0] as CacheKey;
    const flightKey = `${primary.serialized}:${fingerprint}`;
    const existing = this.resolutionFlights.get(flightKey);
    if (existing !== undefined) return existing;
    if (this.resolutionFlights.size >= RESOLUTION_FLIGHT_LIMIT) {
      throw new FlightLimitError();
    }
    const generations = this.generationSnapshot(keys, domain);
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await compute();
        if (result.transitioned) this.invalidateSessionDomain(result.state_domain);
        this.cachePut(keys, result, fingerprint, generations);
        return result;
      } finally {
        this.releaseGenerations(keys);
      }
    }).finally(() => {
      if (this.resolutionFlights.get(flightKey) === pending) this.resolutionFlights.delete(flightKey);
    });
    this.resolutionFlights.set(flightKey, pending);
    return pending;
  }

  async beforePromptBuild(
    event: BeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<{ appendSystemContext?: string } | undefined> {
    let routeCtx: Record<string, unknown> = {};
    let turnKey: string | undefined;
    try {
      routeCtx = routeContextFromHook(ctx);
      turnKey = typeof ctx.runId === "string" && ctx.runId.length > 0 ? ctx.runId : undefined;
      const resolution = this.resolution(routeCtx);
      const compute = () => this.core.turn({
        ctx: routeCtx,
        utterance: event.prompt,
        actor: resolution.route.owner_verified === true ? "owner" : "unknown",
        ...(turnKey === undefined ? {} : { turn_key: turnKey }),
      }, {
        installRoot: this.installRoot,
        engineVersion: ENGINE_VERSION,
        warn: this.warn,
      });
      const result = await this.resolveTurn(
        this.cacheKeys(ctx),
        resolution.state_domain,
        requestFingerprint(event, ctx),
        compute,
      );
      return result.block.length === 0 ? undefined : { appendSystemContext: result.block };
    } catch (error) {
      await this.report(error, routeCtx, turnKey);
      return undefined;
    }
  }

  toolFactory(ctx: OpenClawPluginToolContext): AgentTool<typeof PERSONA_SET_PARAMETERS, SetResult> | null {
    let routeCtx: Record<string, unknown> = {};
    try {
      routeCtx = routeContextFromTool(ctx);
      const resolution = this.resolution(routeCtx);
      if (resolution.route.switching !== "explicit-and-agent" ||
        resolution.route.owner_verified !== true ||
        ctx.senderIsOwner !== true) return null;

      return {
        name: "persona_set",
        label: "Set Persona Mode",
        description: "Set the persona mode for the next turn.",
        parameters: PERSONA_SET_PARAMETERS,
        execute: async (_toolCallId: string, params: Static<typeof PERSONA_SET_PARAMETERS>) => {
          try {
            if (typeof params.mode !== "string" ||
              params.mode.length > MODE_ID_MAX_LENGTH ||
              !MODE_ID.test(params.mode)) {
              throw new Error(PERSONA_SET_REJECTION);
            }
            const result = await this.core.set({
              actor: "agent",
              ctx: routeCtx,
              requested_mode: params.mode,
            }, {
              installRoot: this.installRoot,
              engineVersion: ENGINE_VERSION,
              warn: this.warn,
            });
            if (!result.ok) {
              throw new Error(PERSONA_SET_REJECTION);
            }
            if (result.transitioned) this.invalidateSessionDomain(resolution.state_domain);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: result,
            };
          } catch (error) {
            await this.report(error, routeCtx);
            throw error;
          }
        },
      };
    } catch (error) {
      void this.report(error, routeCtx).catch(() => {});
      return null;
    }
  }
}

export function registerAdapter(api: OpenClawPluginApi): OpenClawAdapter | undefined {
  const installRoot = configuredInstallRoot(api);
  if (installRoot.length === 0) {
    try {
      api.logger.warn("persona: adapter disabled because install root is not configured");
    } catch {
      // Host logging is best-effort and must never prevent registration.
    }
    return undefined;
  }
  const adapter = new OpenClawAdapter(installRoot, (message) => api.logger.warn(message));
  api.on("before_prompt_build", (event, ctx) => adapter.beforePromptBuild(event, ctx));
  api.registerTool((ctx) => adapter.toolFactory(ctx), { name: "persona_set" });
  return adapter;
}
