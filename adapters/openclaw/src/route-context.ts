import type {
  OpenClawPluginToolContext,
  PluginHookAgentContext,
} from "./openclaw-types.js";

const AGENT_SESSION_KEY = /^agent:([^:]+):(.+)$/iu;
const RESERVED_SESSION_KEY_REST_PREFIXES = ["subagent:", "cron:", "explicit:"] as const;

export type RouteContext = Record<string, string>;

export function parseAgentSessionKey(sessionKey: unknown): string | undefined {
  if (typeof sessionKey !== "string") return undefined;
  const match = AGENT_SESSION_KEY.exec(sessionKey);
  return match?.[2];
}

function isReservedSessionKeyRest(rest: string): boolean {
  const normalized = rest.toLowerCase();
  return RESERVED_SESSION_KEY_REST_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function routeContextFromHook(ctx: PluginHookAgentContext): RouteContext {
  const rest = parseAgentSessionKey(ctx.sessionKey);
  if (rest === undefined || isReservedSessionKeyRest(rest)) return {};
  return {
    session_key_rest: rest,
    ...(typeof ctx.channelId === "string" && ctx.channelId.length > 0
      ? { channel_id: ctx.channelId }
      : {}),
  };
}

export function routeContextFromTool(ctx: OpenClawPluginToolContext): RouteContext {
  const rest = parseAgentSessionKey(ctx.sessionKey);
  if (rest === undefined || isReservedSessionKeyRest(rest)) return {};
  return {
    session_key_rest: rest,
    ...(typeof ctx.messageChannel === "string" && ctx.messageChannel.length > 0
      ? { channel_id: ctx.messageChannel }
      : {}),
  };
}
