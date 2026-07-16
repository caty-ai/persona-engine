import type { Static, TSchema } from "@sinclair/typebox";

/** Structural subset of OpenClaw 2026.4.5's declared plugin API. */
export type PluginHookAgentContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channelId?: string;
};

export type BeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

export type OpenClawPluginToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  senderIsOwner?: boolean;
};

export type AgentToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
};

export type AgentTool<TParameters extends TSchema, TDetails> = {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<TDetails>) => void,
  ) => Promise<AgentToolResult<TDetails>>;
};

export type PluginLogger = {
  warn: (message: string) => void;
};

export type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on: (
    hook: "before_prompt_build",
    handler: (
      event: BeforePromptBuildEvent,
      ctx: PluginHookAgentContext,
    ) => Promise<{ appendSystemContext?: string } | void> | { appendSystemContext?: string } | void,
  ) => void;
  registerTool: (
    factory: (ctx: OpenClawPluginToolContext) => AgentTool<any, any> | null | undefined,
    options?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
};

export type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};
