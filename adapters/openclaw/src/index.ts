import { registerAdapter } from "./adapter.js";
import type { OpenClawPluginDefinition } from "./openclaw-types.js";

const plugin: OpenClawPluginDefinition = {
  id: "persona-engine",
  name: "Persona Engine",
  description: "Route-scoped persona injection and switching for OpenClaw.",
  register(api) {
    registerAdapter(api);
  },
};

export default plugin;
export { OpenClawAdapter, registerAdapter } from "./adapter.js";
export { parseAgentSessionKey, routeContextFromHook, routeContextFromTool } from "./route-context.js";
export { loadBuild, resolveRoute, resolveRouteContext, routeMatches } from "./route-resolution.js";
export type * from "./openclaw-types.js";
