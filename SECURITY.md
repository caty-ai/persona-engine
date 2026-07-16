# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately, preferably via GitHub's private vulnerability reporting (Security tab → "Report a vulnerability" on this repository), or by email to cat2.catyyyyyy000@gmail.com. Do not open a public issue or discussion. Include a clear description, affected versions or commit, reproduction steps or proof of concept, impact, and any suggested mitigation.

We will acknowledge reports within 7 days, assess them privately, and work with reporters on disclosure timing. Do not disclose a vulnerability publicly until a fix or mitigation is available and coordinated disclosure is agreed.

## Supported versions

Security fixes are applied to the latest released version. Pre-release builds may change without compatibility guarantees.

## Threat model: prompt injection

persona-engine limits untrusted input from selecting or expanding a personality mode. It does not make an LLM immune to prompt injection; operators must still apply their runtime's normal security controls.

- Route context comes from trusted runtime metadata, never model output or message text.
- Unknown, unresolved, or malformed route context resolves to the empty `public` mode with switching denied.
- Every requested transition—explicit, agent-initiated, or CLI—passes core policy evaluation. Rejection does not redirect to another mode.
- Agent switching is available only on explicitly configured, owner-verified routes. The model-visible `persona_set` interface accepts only a mode; route, session, and actor identity are runtime-bound.
- Every block resolution checks the current mode against the route's allowed modes. A mismatch returns the empty public block without overwriting state.
- Adapters catch failures and fall back to no injection while recording an audit event; they do not rely on host middleware failure behavior.
- Runtime paths consume compiled artifacts rather than YAML and validate them before injection.

Keep routes narrowly scoped, never mark shared or group surfaces as owner-verified, and review adapter-specific trust assumptions. A route that elevates access based on client-supplied session metadata is safe only when every authenticated client allowed to supply it has the intended trust level.

## Secrets and sensitive content

Do not place API keys, passwords, tokens, or other secrets in pack files or placeholders. Compiled blocks are stored as plaintext. Health checks can warn about common secret-shaped strings but cannot guarantee detection. Audit output intentionally excludes utterance and block content; protect pack sources, build artifacts, and host access for your environment.

persona-engine assumes the install root is owned by a single UID. On shared hosts, keep the `state/` directory at mode `0700`; state and status files record mode ids and block hashes (never block content), but those ids are still yours to protect.

## Scope

Report issues affecting the core, supported adapters, release artifacts, or documented security behavior. Reports about a third-party pack should go to that pack's maintainer unless the issue is caused by persona-engine's handling of it.
