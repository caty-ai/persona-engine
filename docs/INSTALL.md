# Install

`persona` requires Node.js 22 or later.

## From npm

The final package name will be announced at release. Until then, substitute the released package name for `<package>`:

```sh
npx <package> init
npx <package> build
npx <package> doctor
```

`init` opens a short wizard in an interactive terminal. It creates a starter pack, `build` compiles it, and `doctor` checks the result. In scripts or CI, use `npx <package> init --yes` for the default non-interactive scaffold. With a global or project-local install, the same commands are available as `persona init`, `persona build`, and `persona doctor`.

## From a source checkout

```sh
git clone <repository-url>
cd persona-engine
npm ci
node packages/core/bin/persona init --yes ./my-persona
node packages/core/bin/persona build --dir ./my-persona
node packages/core/bin/persona doctor --dir ./my-persona
```

The source-checkout bootstrap uses Node's TypeScript strip-types support when compiled output is unavailable. Note that `npm ci` compiles `packages/core/dist/`, and the `persona` bin prefers that compiled output when present — after editing TypeScript sources, rebuild it with `npm run build --workspace @persona-engine/core` so the CLI picks up your changes.

## Troubleshooting

Run `persona doctor --dir <pack-directory>` to diagnose a pack. Confirm that you are using Node.js 22 or newer, then rebuild the pack after correcting reported errors.

## Uninstall

Remove a globally installed package with your package manager, or delete the generated pack directory when it is no longer needed. `npx` installations do not require a global uninstall step.
