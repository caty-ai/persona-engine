# persona-engine

![status](https://img.shields.io/badge/status-pre--release-orange)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

## Overview

persona-engine is a safe, policy-driven engine for switching personality modes in LLM agents. Define a pack in YAML, compile it once, and use runtime adapters to inject the resulting blocks per turn.

## Features

- Runtime paths read compiled artifacts rather than YAML.
- Unknown routes resolve to the empty `public` mode and cannot switch.
- Payload content remains opaque; the engine handles structure, references, budgets, and order.
- Explicit, agent, and CLI switches pass through core policy evaluation.
- A compiled block stays byte-identical while its mode is active.

## Architecture

```text
pack/ (YAML) -> persona build -> build/ (compiled blocks + policy) -> adapter -> LLM runtime
```

An adapter derives route context from trusted runtime metadata, asks the core to resolve a block, and injects that block at the runtime's request-scoped extension point.

## Quick start

Requires Node.js 22 or later.

```sh
git clone https://github.com/caty-ai/persona-engine.git
cd persona-engine
npm install
alias persona="$PWD/packages/core/bin/persona"
persona init ./my-persona
```

## Create and build a pack

Create a starter pack, then build its compiled artifacts.

```sh
cd my-persona
persona build
persona doctor
```

## Starter pack

A general-purpose four-mode v2 pack ships in [templates/pack-starter/](templates/pack-starter/). Copy it, rename `install.example.yml` to `install.yml`, adjust the pack name, placeholders, and route policy for your setup, then run `persona build` / `persona doctor`.

## Switching model

There are three switching paths; every transition is recorded in the audit log.

1. **Explicit** — a full-utterance alias match (for example, "switch to focus"). Active only on routes whose `switching` level is explicit or higher.
2. **Agent-initiated** — the `persona_set` tool. Registered only on routes with `switching: explicit-and-agent` and `owner_verified: true`.
3. **Admin** — `persona set <mode> --domain <domain>` from the CLI.

To add modes, drop new `pack/modes/*.yml` files and rerun `persona build`. Placeholders such as `{{agent-name}}` / `{{owner-name}}` resolve from the `install.yml` declarations; an unresolved placeholder stops the build with `E_PLACEHOLDER_UNRESOLVED`.

## Configure route policy

An install configuration chooses the pack, runtime, routes, placeholders, and audit location. Configure routes before enabling switching; shared and group surfaces should remain conservative.

## CLI

```sh
persona build
persona list
persona get --domain default
persona set public --domain default
persona audit
```

See [SPEC.md](SPEC.md) for the complete format and policy contract.

## Adapters

- [Claude Code](adapters/claude-code/README.md)
- [Hermes](adapters/hermes/README.md)
- [OpenClaw](adapters/openclaw/README.md)

## Security notes

Treat packs as trusted operator assets. Do not put credentials or other secrets in placeholders or pack content: compiled blocks are plaintext on disk. State stays on the injecting host and is not synchronized between machines.

## Documentation

- [Installation guide](docs/INSTALL.md)
- [Security policy](SECURITY.md)
- [Contribution guide](CONTRIBUTING.md)

## Development

```sh
npm install
npm test
npm run typecheck
python3 -m pytest adapters
```

Shared fixtures under `spec/fixtures/` verify TypeScript core and Python adapter behavior against the same runtime contract.

## Roadmap

- [x] M0 — runtime spike + SPEC freeze
- [x] M1 — core (compiler / policy / state / turn / CLI)
- [x] M2 — Hermes adapter + doctor + first production agent deployment
- [x] M3 — OpenClaw adapter + observability CLI (get / list / audit) + voice coloring + agent-initiated switching
- [ ] M4 — public release: npm packaging + init wizard / starter pack template / Claude Code adapter / license & security gates

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

MIT © Caty. See [LICENSE](LICENSE).
