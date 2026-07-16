import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initCommand, type InitParsedArgs } from "../../src/cli/init.js";

const roots: string[] = [];

function parsed(root: string, options: Record<string, string> = {}): InitParsedArgs {
  return { positionals: [root], options: new Map(Object.entries(options)) };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "persona-init-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persona init", () => {
  it("uses defaults without prompting when IO is non-interactive", async () => {
    const root = await temporaryRoot();
    const output: unknown[] = [];

    await expect(initCommand(parsed(root), { interactive: false, writeJson: (value) => output.push(value) })).resolves.toBe(0);

    expect(output).toEqual([{ ok: true, install_dir: root }]);
    await expect(readFile(resolve(root, "install.yml"), "utf8")).resolves.toContain("runtime: generic");
    await expect(readFile(resolve(root, "pack/manifest.yml"), "utf8")).resolves.toContain('name: "my-persona"');
    await expect(readFile(resolve(root, "pack/modes/default.yml"), "utf8")).resolves.toContain("sections:");
  });

  it("retries invalid scripted wizard answers and accepts empty defaults", async () => {
    const root = await temporaryRoot();
    const answers = ["bad\nname", "", "INVALID", "focus", "wrong", "hermes", "0", ""];
    const stderr: string[] = [];

    await initCommand(parsed(root), {
      interactive: true,
      ask: async () => answers.shift() ?? "",
      writeStderr: (message) => stderr.push(message),
      writeJson: () => undefined,
    });

    await expect(readFile(resolve(root, "pack/manifest.yml"), "utf8")).resolves.toContain('name: "my-persona"');
    await expect(readFile(resolve(root, "install.yml"), "utf8")).resolves.toContain("runtime: hermes");
    await expect(readFile(resolve(root, "pack/modes/focus.yml"), "utf8")).resolves.toContain("sections:");
    await expect(readFile(resolve(root, "pack/manifest.yml"), "utf8")).resolves.toContain("default_budget_tokens: 600");
    expect(stderr.join("")).toContain("must be non-empty printable ASCII");
    expect(stderr.join("")).toContain("must match /^[a-z0-9-]+$/");
    expect(stderr.join("")).toContain("must be one of generic, openclaw, hermes");
    expect(stderr.join("")).toContain("must be an integer from 1 to 100000");
    expect(stderr.join("")).toContain("persona build");
  });

  it("uses flags in either path and writes a matching route and mode", async () => {
    const root = await temporaryRoot();

    await initCommand(parsed(root, {
      yes: "",
      name: "demo",
      mode: "focus",
      runtime: "openclaw",
      budget: "900",
    }), { interactive: true, ask: async () => { throw new Error("must not prompt"); }, writeJson: () => undefined });

    await expect(readFile(resolve(root, "install.yml"), "utf8")).resolves.toContain("allowed_modes: [public, focus]");
    await expect(readFile(resolve(root, "install.yml"), "utf8")).resolves.toContain("runtime: openclaw");
    await expect(readFile(resolve(root, "pack/manifest.yml"), "utf8")).resolves.toContain("default_budget_tokens: 900");
    await expect(readFile(resolve(root, "pack/modes/focus.yml"), "utf8")).resolves.toContain("sections:");
  });

  it("quotes pack names containing YAML indicator characters", async () => {
    const root = await temporaryRoot();

    await initCommand(parsed(root, { name: "[demo: pack] #1" }), { interactive: false, writeJson: () => undefined });

    await expect(readFile(resolve(root, "pack/manifest.yml"), "utf8")).resolves.toContain('name: "[demo: pack] #1"');
  });

  it("refuses to overwrite an existing scaffold file", async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, "install.yml"), "existing\n", "utf8");

    await expect(initCommand(parsed(root), { interactive: false, writeJson: () => undefined }))
      .rejects.toThrow("refusing to overwrite existing file");
  });

  it("rejects invalid mode ids and budgets before creating a scaffold", async () => {
    const root = await temporaryRoot();
    await expect(initCommand(parsed(root, { mode: "UPPER" }), { interactive: false, writeJson: () => undefined }))
      .rejects.toThrow("--mode must match");
    await expect(initCommand(parsed(root, { budget: "100001" }), { interactive: false, writeJson: () => undefined }))
      .rejects.toThrow("--budget must be an integer");
  });
});
