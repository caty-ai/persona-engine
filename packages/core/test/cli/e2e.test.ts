import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = resolve(import.meta.dirname, "../../bin/persona");
const temporaryRoots: string[] = [];

async function run(root: string, ...args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(BIN, args, { cwd: root, encoding: "utf8" });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runFailure(root: string, ...args: string[]): Promise<Record<string, unknown>> {
  try {
    await execFileAsync(BIN, args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") return JSON.parse(stdout) as Record<string, unknown>;
    throw error;
  }
  throw new Error("Expected persona CLI command to fail");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persona CLI E2E", () => {
  it("spawns bin/persona for init -> build -> set -> get -> turn", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "persona-cli-e2e-"));
    temporaryRoots.push(parent);
    const root = resolve(parent, "install");

    await expect(run(parent, "init", root)).resolves.toMatchObject({ ok: true, install_dir: root });
    expect((await stat(resolve(root, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(root, "audit"))).mode & 0o777).toBe(0o700);
    await expect(run(root, "build")).resolves.toMatchObject({ ok: true });
    await expect(run(root, "set", "default", "--domain", "default")).resolves.toMatchObject({
      ok: true,
      mode: "default",
      transitioned: true,
    });
    await expect(run(root, "get", "--domain", "default", "--json")).resolves.toMatchObject({
      domain: "default",
      mode: "default",
      revision: 1,
    });
    await expect(run(root, "turn", "--domain", "default")).resolves.toMatchObject({
      mode: "default",
      block: expect.stringContaining("Replace this text with your persona instructions."),
      route_id: "__admin__",
      state_domain: "default",
    });
    await expect(run(root, "turn")).resolves.toMatchObject({
      mode: "public",
      block: "",
      route_id: "__admin__",
      state_domain: "default",
    });
    await expect(run(root, "doctor")).resolves.toMatchObject({
      ok: true,
      issues: [],
      status: { present: true, age_seconds: expect.any(Number) },
    });
  });

  it("maps build, policy, and usage failures to exit codes 1, 2, and 3", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "persona-cli-exits-"));
    temporaryRoots.push(parent);
    await expect(execFileAsync(BIN, ["build"], { cwd: parent })).rejects.toMatchObject({ code: 1 });
    await expect(execFileAsync(BIN, ["turn"], { cwd: parent })).rejects.toMatchObject({ code: 1 });

    const root = resolve(parent, "install");
    await run(parent, "init", root);
    await run(root, "build");
    await expect(
      execFileAsync(BIN, ["set", "missing", "--domain", "default"], { cwd: root }),
    ).rejects.toMatchObject({ code: 2 });
    const manifestPath = resolve(root, "build/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, pack_name: "Invalid_Pack" })}\n`, "utf8");
    await expect(execFileAsync(BIN, ["doctor"], { cwd: root })).rejects.toMatchObject({ code: 1 });
    await writeFile(resolve(root, "state/default.json"), "not-json\n", "utf8");
    await expect(
      execFileAsync(BIN, ["get", "--domain", "default"], { cwd: root }),
    ).rejects.toMatchObject({ code: 3 });
    await expect(execFileAsync(BIN, ["unknown"], { cwd: root })).rejects.toMatchObject({ code: 3 });
  });

  it("routes resolvePack YAML-parse failures to E_PARSE and all other resolvePack failures to the E_SCHEMA_VERSION fallback", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "persona-cli-install-errors-"));
    temporaryRoots.push(parent);
    const root = resolve(parent, "install");
    await run(parent, "init", root);

    await writeFile(resolve(root, "install.yml"), "pack: [\n", "utf8");
    await expect(runFailure(root, "build")).resolves.toMatchObject({
      ok: false,
      errors: [{ code: "E_PARSE" }],
    });

    // E_SCHEMA_VERSION is the catch-all for any non-parse resolvePack failure.
    await writeFile(resolve(root, "install.yml"), "schema_version: 2\nruntime: generic\n", "utf8");
    await expect(runFailure(root, "build")).resolves.toMatchObject({
      ok: false,
      errors: [{ code: "E_SCHEMA_VERSION" }],
    });
  });

  it("routes a missing install.yml to the E_SCHEMA_VERSION fallback", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "persona-cli-missing-install-"));
    temporaryRoots.push(parent);

    await expect(runFailure(parent, "build", "--install", resolve(parent, "missing-install.yml"))).resolves.toMatchObject({
      ok: false,
      errors: [{ code: "E_SCHEMA_VERSION" }],
    });
  });
});
