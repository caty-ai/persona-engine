# Contributing to persona-engine

Thanks for contributing.

## Before you start

- Search existing issues and discussions before opening a new one.
- Open an issue for substantial changes so design and compatibility impact can be discussed first.
- Do not include credentials, private prompts, personal data, or proprietary pack content in issues, commits, tests, or examples.

## Development

Node.js 22 or later is required.

```sh
npm install
npm test
npm run typecheck
python3 -m pytest adapters/hermes
```

Keep changes focused, add or update tests for behavioral changes, and preserve the fail-closed policy contract. Shared runtime fixtures belong in `spec/fixtures/` when TypeScript and Python implementations must agree.

## Pull requests

Explain the problem, approach, and verification performed. Keep commits reviewable and avoid unrelated formatting changes. Keep English and Japanese documentation aligned where applicable.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior to cat2.catyyyyyy000@gmail.com.

## Security reports

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](SECURITY.md).
