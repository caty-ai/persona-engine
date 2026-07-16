import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = resolve(import.meta.dirname, "../../bin/persona");
const temporaryRoots: string[] = [];

async function runJson(root: string, args: string[], input: unknown): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(BIN, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 3, stdout, stderr }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function runChunkedJson(root: string, args: string[], input: unknown, splitAt: number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const encoded = Buffer.from(JSON.stringify(input), "utf8");
  const child = spawn(BIN, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const result = new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 3, stdout, stderr }));
  });
  child.stdin.write(encoded.subarray(0, splitAt));
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
  child.stdin.end(encoded.subarray(splitAt));
  return result;
}

async function createInstall(): Promise<string> {
  const parent = await mkdtemp(resolve(tmpdir(), "persona-cli-stdin-"));
  temporaryRoots.push(parent);
  const root = resolve(parent, "install");
  await execFileAsync(BIN, ["init", "--yes", root]);
  await execFileAsync(BIN, ["build", "--dir", root]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persona stdin JSON CLI", () => {
  it("uses the normal policy resolver rather than the CLI admin route", async () => {
    const root = await createInstall();
    await writeFile(resolve(root, "install.yml"), `schema_version: 2
pack: ./pack
runtime: hermes
routes:
  - id: known-runtime
    match: { platform: known-runtime }
    allowed_modes: [public, default]
    switching: deny
    state_domain: default
default_route:
  state_domain: default
audit:
  dir: audit/
`, "utf8");
    await execFileAsync(BIN, ["build", "--dir", root]);
    const result = await runJson(root, ["turn", "--stdin-json"], {
      actor: "unknown",
      ctx: { platform: "unrecognized-runtime" },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "public",
      route_id: "__default__",
      state_domain: "default",
    });
  });

  it("preserves UTF-8 characters split across stdin chunks", async () => {
    const root = await createInstall();
    await writeFile(resolve(root, "install.yml"), `schema_version: 2
pack: ./pack
runtime: hermes
routes:
  - id: accented-runtime
    match: { platform: café }
    allowed_modes: [public, default]
    switching: deny
    state_domain: default
default_route:
  state_domain: default
audit:
  dir: audit/
`, "utf8");
    await execFileAsync(BIN, ["build", "--dir", root]);

    const input = { actor: "unknown", ctx: { platform: "café" } };
    const splitAt = Buffer.from(JSON.stringify(input), "utf8").indexOf(Buffer.from("é", "utf8")) + 1;
    const result = await runChunkedJson(root, ["turn", "--stdin-json"], input, splitAt);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ route_id: "accented-runtime" });
  });

  it("rejects malformed input without mutating state", async () => {
    const root = await createInstall();
    const result = await runJson(root, ["turn", "--stdin-json"], "{");

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stdin must contain valid JSON");
    await expect(readFile(resolve(root, "state/default.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps policy rejection and invalid builds to runtime exit codes", async () => {
    const root = await createInstall();
    await writeFile(resolve(root, "install.yml"), `schema_version: 2
pack: ./pack
runtime: generic
routes:
  - id: restricted-runtime
    match: {}
    allowed_modes: [public]
    switching: explicit
    owner_verified: true
    state_domain: default
default_route:
  state_domain: default
audit:
  dir: audit/
`, "utf8");
    await execFileAsync(BIN, ["build", "--dir", root]);
    const rejected = await runJson(root, ["turn", "--stdin-json"], {
      actor: "owner",
      utterance: "/persona default",
      ctx: {},
    });
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ rejected: { requested_mode: "default" } });

    const manifestPath = resolve(root, "build/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, pack_name: "Invalid_Pack" })}\n`, "utf8");
    const invalid = await runJson(root, ["turn", "--stdin-json"], { actor: "unknown", ctx: {} });
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ mode: "public", block: "" });
  });

  it("reports adapter errors from JSON stdin", async () => {
    const root = await createInstall();
    const result = await runJson(root, ["report-adapter-error", "--stdin-json"], {
      error: { name: "AdapterFailure" },
      ctx: { domain: "default", route_id: "__default__", turn_key: "session-1" },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      audit: [{ event: "adapter_error", reason: "AdapterFailure" }],
    });
  });
});
