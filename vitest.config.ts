import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // absolute path: workspace-scoped runs (npm run test --workspace ...)
    // resolve relative globalSetup paths against the workspace cwd, not this
    // config file, and fail with ERR_MODULE_NOT_FOUND
    globalSetup: fileURLToPath(new URL("./vitest.global-setup.ts", import.meta.url)),
  },
});
