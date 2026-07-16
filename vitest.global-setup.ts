import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default function globalSetup(): Promise<void> {
  return new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build", "--workspace", "@persona-engine/core"], {
      cwd: repositoryRoot,
      stdio: "inherit",
      // npm resolves to npm.cmd on Windows, which Node refuses to spawn
      // without a shell (CVE-2024-27980).
      shell: process.platform === "win32",
    });

    build.once("error", reject);
    build.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Core build failed before tests started (code: ${code}, signal: ${signal})`));
    });
  });
}
