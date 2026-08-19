# Contributing to persona-engine

Thanks for contributing.

## Before you start

- Search existing issues and discussions before opening a new one.
- Open an issue for substantial changes so design and compatibility impact can be discussed first.
- Do not include credentials, private prompts, personal data, or proprietary pack content in issues, commits, tests, or examples.

## Prerequisites

- Node.js 22 or later (npm included) — the core runtime and tests
- GNU `make` or BSD `make` — the repository entry points are `make test` and `make lint`
- Python 3.11+ with `pytest` — only for the adapter suites (`adapters/hermes`, `adapters/claude-code`); the core suite does not need Python

## Development

The repository entry point is `make test`. It installs dependencies with `npm ci` when needed, builds the core package, and runs the core suite — the same command CI runs. `make lint` runs the typecheck.

```sh
make test
make lint
python3 -m pytest adapters   # adapter suites (Python; CI runs them as separate jobs)
```

Keep changes focused, add or update tests for behavioral changes, and preserve the fail-closed policy contract. Shared runtime fixtures belong in `spec/fixtures/` when TypeScript and Python implementations must agree.

## Pull requests

Explain the problem, approach, and verification performed. Keep commits reviewable and avoid unrelated formatting changes. Keep English and Japanese documentation aligned where applicable.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior to cat2.catyyyyyy000@gmail.com.

## Security reports

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](SECURITY.md).
