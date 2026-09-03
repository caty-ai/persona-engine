import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

// packages/core/test/pack.test.ts shells out to `npm pack`. Under npm 10.x
// (the npm bundled with Node 22, i.e. CI) `--ignore-scripts` is not honoured
// for a workspace package: npm still runs `prepare` -> `npm run build` -> `tsc`, which rewrites
// packages/core/dist/ file by file. Every other CLI test spawns bin/persona
// from that same dist/, so running pack.test.ts alongside them produces
// truncated or mixed-version dist modules (issue #16). The pack group therefore
// runs alone, after every other file has finished. npm 11 honours the flag, so
// the race never reproduces locally with a current npm.
const packTests = ["packages/core/test/pack.test.ts"];

export default defineConfig({
  test: {
    // absolute path: workspace-scoped runs (npm run test --workspace ...)
    // resolve relative globalSetup paths against the workspace cwd, not this
    // config file, and fail with ERR_MODULE_NOT_FOUND
    globalSetup: fileURLToPath(new URL("./vitest.global-setup.ts", import.meta.url)),
    projects: [
      {
        test: {
          name: "suite",
          root: repositoryRoot,
          exclude: [...configDefaults.exclude, ...packTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "pack",
          root: repositoryRoot,
          include: packTests,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
