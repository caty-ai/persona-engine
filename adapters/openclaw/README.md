# Persona Engine OpenClaw adapter

This typed plugin injects Persona Engine's compiled block through OpenClaw's
`before_prompt_build` `appendSystemContext` result and exposes `persona_set`
only on owner-verified `explicit-and-agent` routes.

## Configuration

Set `plugins.entries.persona-engine.config.installRoot` in OpenClaw's config.
The adapter resolves its install root in this order:

1. OpenClaw native plugin config: `pluginConfig.installRoot`
2. `PERSONA_ENGINE_INSTALL_ROOT`

If neither is present, registration is disabled with a warning. The configured
root must contain the compiled `build/` artifacts and writable `state/` and
audit locations expected by Persona Engine.

## Turn caching

OpenClaw 2026.4.5 does not expose a reliably turn-unique identifier: integration
evidence has shown the same `PluginHookAgentContext.runId` (`turn_key`) on
distinct logical turns. This is the SPEC §7.4 fallback condition: if no
`turn_id` equivalent is available, use a session-scoped cache with
invalidate-on-transition. Accordingly, session identity (`sessionId`, with
`sessionKey` fallback) is authoritative, and `runId` is used only when no
session identity exists. Cache entries carry a fingerprint of the current
prompt and prepared messages and expire at the next microtask checkpoint,
because the host exposes no trustworthy boundary that would make completed
results safe to reuse across later hook deliveries.

Pending resolutions live in a separate session-keyed single-flight map. Thus
concurrent duplicate hook delivery awaits one `turn()` promise, and completed
cache LRU eviction (1024 turn entries, 256 session entries) cannot remove an
in-flight call. At most 512 distinct resolutions receive single-flight cache
bookkeeping at once; when that limit is reached, brand-new distinct turn resolutions fail closed (no injection, reported via `report_adapter_error` with category `"flight-limit"`) rather than computing uncached, preserving byte-identity for any duplicate/concurrent delivery of the same turn over the alternative of an uncached, potentially divergent result. Joining a pending resolution always
returns that in-flight snapshot as-is, byte-identically, even if a transition
happens concurrently; joined calls never re-check generations or recompute.
Generation counters are tracked per cache key and state domain.
When `TurnResult.transitioned` is true, every session entry for that domain is
evicted and its generation is advanced; the transitioned result is never put
back into the session tier. A successful `persona_set` applies the same domain
invalidation only when its result reports a transition. Stale in-flight work
whose generation predates invalidation is therefore unable to repopulate the
session cache.
Only eviction of settled session-cache entries implements the §7.4 guarantee
that the next non-joining turn reflects the new state.

The route-resolution sibling reads only Persona Engine's stable compiled build
contract (`policy.json`, `manifest.json`, `triggers.json`, and mode blocks),
validates it with the same schema and integrity checks as core/Hermes, and uses
the resolved route solely for actor binding and tool visibility. Core still
performs the authoritative policy evaluation for every `turn()` and `set()`.

## Build and test

```sh
export PATH=/usr/local/bin:$PATH
npm run build --workspace @persona-engine/openclaw-adapter
npm run test --workspace @persona-engine/openclaw-adapter
```

The local integration test requires the read-only OpenClaw 2026.4.5 install at
`~/.npm-global/lib/node_modules/openclaw/`. It creates a temporary isolated
`OPENCLAW_HOME`, starts a loopback mock provider, and never reads or writes the
real `~/.openclaw`:

```sh
npm run test:integration --workspace @persona-engine/openclaw-adapter
```

Its machine-readable evidence is written to
`test/integration/report.json`.
