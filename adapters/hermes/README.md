# Hermes adapter

This adapter injects compiled persona-engine v2 blocks through Hermes's
request-scoped `llm_request` middleware. It does not read YAML and does not
modify Hermes bootstrap files.

## Install

1. Build the persona-engine install separately so it contains `build/` and
   `state/` under `~/.persona-engine/<agent>/`.
2. Copy or symlink this directory, unchanged, to the user plugin directory at
   `~/.hermes/plugins/persona-engine/`. Hermes directory plugins require both
   the included `plugin.yaml` and this package's `__init__.py` entry point.
3. Add `persona-engine` to `plugins.enabled` in the Hermes configuration;
   user plugins are opt-in and are not loaded merely because the directory is
   present.
4. Set `PERSONA_ENGINE_INSTALL_ROOT=~/.persona-engine/<agent>` in the Hermes
   process environment. A host-supplied `persona_engine_install_root` plugin
   configuration value takes precedence when available. The adapter is
   disabled when neither value is configured.
5. Optionally set `persona_engine_sessions_file` in plugin configuration (or
   `PERSONA_ENGINE_SESSIONS_FILE`) to the profile's `sessions.json`. Otherwise
   it defaults to `~/.hermes/profiles/<profile>/sessions/sessions.json`, where
   `<profile>` comes from `persona_engine_profile`, `HERMES_PROFILE`, or
   `default`. Lookup failure never satisfies a `session_key` route.
6. Restart Hermes, then verify a public route produces no added
   system message/instructions and an allowed private route produces the
   compiled block.

The runtime is Python 3.10+ and uses only the standard library. Hermes discovers
the plugin from `plugin.yaml` and calls the `register(ctx)` exported by
`__init__.py`.

## Trust boundary and route degradation

Hermes supplies `platform`, `session_id`, optional `session_key`, and
`api_mode` as trusted middleware context. For `api_server`, however,
`session_key` is a client-asserted value inside the Bearer-authenticated API.
A route that promotes a `session_key` prefix to private therefore assumes
that every authenticated client able to reach that API server has the same
trust level. Do not share those credentials with lower-trust clients.

Hermes middleware has no per-message sender id for group/channel surfaces.
Any route that can contain multiple speakers must degrade to
`allowed_modes: [public]`, `switching: deny`, and must not declare
`owner_verified: true`. Missing required context, an unknown platform, or a
failed session lookup resolves through the compiled default route (public,
switching denied).

When Hermes omits `turn_id`, the adapter uses a session-scoped resolution
cache. Successful owner or agent transitions invalidate or refresh the
affected state domain before the next session-scoped injection.

Degraded: a turn-keyed cache miss after the first API call emits a host warning
and resolves without an utterance, so trigger evaluation is not repeated.

## Known unmeasured behavior

The mapping from an API `conversation` value to middleware `session_id` has
only static-analysis evidence. It must be measured in the M2 acceptance test,
including `X-Hermes-Session-Key` propagation and the voice route prefix,
before production rollout. Middleware injection/tool filtering behavior is
also part of that live acceptance test; this repository does not deploy to
any live agent instance.
