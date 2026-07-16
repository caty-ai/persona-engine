import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CORE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(CORE_ROOT, "../..");
const temporaryRoots: string[] = [];

type PackResult = {
  filename: string;
  files: Array<{ path: string }>;
};

function parsePackJson(output: string): PackResult {
  const start = output.lastIndexOf("\n[");
  const json = start === -1 ? output : output.slice(start + 1);
  const result = JSON.parse(json) as PackResult[];
  if (result.length !== 1) throw new Error(`Expected one npm pack result, got ${result.length}`);
  return result[0] as PackResult;
}

async function npmPack(args: string[], cache: string): Promise<PackResult> {
  const { stdout } = await execFileAsync("npm", ["pack", ...args], {
    cwd: CORE_ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
  return parsePackJson(stdout);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("npm package contents", () => {
  it("packs with --ignore-scripts only while prepare is exactly the plain build", async () => {
    // These pack tests skip lifecycle scripts and rely on vitest.global-setup.ts
    // having built dist/ up front. That is only faithful to a real `npm pack`
    // while the pack-affecting lifecycle is exactly `prepare: npm run build`.
    // If this fails, restore fidelity (isolated-copy pack or setup update)
    // before changing the lifecycle scripts.
    const manifest = JSON.parse(await readFile(resolve(CORE_ROOT, "package.json"), "utf8"));
    const scripts = manifest.scripts as Record<string, string>;
    const packLifecycle = ["prepack", "prepare", "prepublishOnly", "postpack"]
      .filter((name) => name in scripts)
      .map((name) => `${name}=${scripts[name]}`);
    expect(packLifecycle).toEqual(["prepare=npm run build"]);
  });

  it("keeps the published artifact to its explicit public allowlist", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "persona-pack-dry-run-"));
    temporaryRoots.push(temporary);
    const result = await npmPack(["--dry-run", "--json", "--ignore-scripts"], resolve(temporary, "npm-cache"));
    const files = result.files.map(({ path }) => path);

    expect(files).toEqual(expect.arrayContaining([
      "bin/persona",
      "dist/cli/index.js",
      "dist/index.js",
      "dist/index.d.ts",
      "LICENSE",
      "README.md",
      "package.json",
    ]));

    const publicFile = (path: string): boolean =>
      path === "bin/persona" ||
      path === "LICENSE" ||
      path === "README.md" ||
      path === "package.json" ||
      /^dist\/.+\.(?:js|d\.ts)$/u.test(path);
    const unexpected = files.filter((path) => !publicFile(path));
    const privateLeakage = files.filter((path) =>
      path.startsWith("src/") || path.startsWith("test/") || path.includes("modes") || /\.ya?ml$/iu.test(path),
    );

    expect(unexpected, `npm pack included files outside the public allowlist: ${unexpected.join(", ")}`).toEqual([]);
    expect(privateLeakage, `npm pack leaked private or YAML source files: ${privateLeakage.join(", ")}`).toEqual([]);
  }, 60_000);

  it("runs the compiled tarball CLI without experimental warnings", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "persona-pack-e2e-"));
    temporaryRoots.push(temporary);
    const tarballs = resolve(temporary, "tarballs");
    await mkdir(tarballs);
    const result = await npmPack(["--json", "--pack-destination", tarballs, "--ignore-scripts"], resolve(temporary, "npm-cache"));
    const extracted = resolve(temporary, "extracted");
    await mkdir(extracted);
    await execFileAsync("tar", ["-xzf", resolve(tarballs, result.filename), "-C", extracted], { encoding: "utf8" });

    const packageRoot = resolve(extracted, "package");
    await mkdir(resolve(packageRoot, "node_modules"));
    await symlink(resolve(REPO_ROOT, "node_modules/yaml"), resolve(packageRoot, "node_modules/yaml"), "dir");
    const installRoot = resolve(temporary, "install");
    const init = await execFileAsync(process.execPath, [resolve(packageRoot, "bin/persona"), "init", "--yes", installRoot], { encoding: "utf8" });
    const build = await execFileAsync(process.execPath, [resolve(packageRoot, "bin/persona"), "build", "--dir", installRoot], { encoding: "utf8" });

    expect(JSON.parse(init.stdout)).toMatchObject({ ok: true });
    expect(JSON.parse(build.stdout)).toMatchObject({ ok: true });
    expect(`${init.stderr}${build.stderr}`).not.toContain("ExperimentalWarning");
  }, 60_000);
});
