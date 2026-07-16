import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fsFault = vi.hoisted(() => ({
  cleanupBackup: false,
  publishDestination: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(...args: Parameters<typeof actual.renameSync>): void {
      if (fsFault.publishDestination === String(args[1])) {
        fsFault.publishDestination = undefined;
        throw new Error("injected publish rename failure");
      }
      actual.renameSync(...args);
    },
    rmSync(...args: Parameters<typeof actual.rmSync>): void {
      if (fsFault.cleanupBackup && /\.[^/\\]+\.old-/u.test(String(args[0]))) {
        fsFault.cleanupBackup = false;
        throw new Error("injected backup cleanup failure");
      }
      actual.rmSync(...args);
    },
  };
});

import { buildPack, compilePack } from "../../src/compile/index.js";
import { BUILD_ERROR_CODES } from "../../src/errors.js";

type CaseMetadata = {
  id: string;
  input: { pack_dir: string; install_file?: string };
  expected: {
    status: "success" | "error";
    error?: string;
    message_includes?: string | string[];
    error_count?: number;
    manifest?: { required_fields?: string[]; counter?: string };
    modes?: string[];
    blocks?: Record<string, string>;
    content_hash?: string;
    mode_hashes?: Record<string, string>;
    mode_bytes?: Record<string, number>;
    mode_tokens?: Record<string, number>;
    mode_voice_hints?: Record<string, string>;
    triggers?: unknown;
    policy?: unknown;
  };
};

const repoRoot = resolve(import.meta.dirname, "../../../..");
const casesRoot = resolve(repoRoot, "spec/fixtures/compile/cases");
const fixedTime = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  fsFault.cleanupBackup = false;
  fsFault.publishDestination = undefined;
  vi.restoreAllMocks();
});

function caseDirectories(): string[] {
  return readdirSync(casesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(casesRoot, entry.name))
    .sort();
}

function loadCase(directory: string): CaseMetadata {
  return JSON.parse(readFileSync(resolve(directory, "case.json"), "utf8")) as CaseMetadata;
}

describe("compile conformance fixtures", () => {
  it("discovers compile fixtures", () => {
    expect(caseDirectories().length).toBeGreaterThan(0);
  });

  it("covers every normative build error code", () => {
    const covered = caseDirectories()
      .map(loadCase)
      .filter((fixture) => fixture.expected.status === "error")
      .map((fixture) => fixture.expected.error);

    expect(new Set(covered)).toEqual(new Set(BUILD_ERROR_CODES));
  });

  for (const directory of caseDirectories()) {
    const fixture = loadCase(directory);

    it(fixture.id, () => {
      const result = compilePack({
        packDir: resolve(directory, fixture.input.pack_dir),
        ...(fixture.input.install_file === undefined ? {} : { installFile: resolve(directory, fixture.input.install_file) }),
        builtAt: fixedTime,
        engineVersion: "0.1.0",
      });

      if (fixture.expected.status === "error") {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(new Set(result.errors.map((error) => error.code))).toEqual(new Set([fixture.expected.error]));
        if (fixture.expected.error_count !== undefined) {
          expect(result.errors.filter((error) => error.code === fixture.expected.error)).toHaveLength(fixture.expected.error_count);
        }
        if (fixture.expected.message_includes !== undefined) {
          const expectedMessages = Array.isArray(fixture.expected.message_includes)
            ? fixture.expected.message_includes
            : [fixture.expected.message_includes];
          for (const expectedMessage of expectedMessages) {
            expect(result.errors.some((error) => error.message.includes(expectedMessage))).toBe(true);
          }
        }
        return;
      }

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { artifacts } = result;
      for (const field of fixture.expected.manifest?.required_fields ?? []) {
        expect(artifacts.manifest).toHaveProperty(field);
      }
      if (fixture.expected.manifest?.counter !== undefined) {
        expect(artifacts.manifest.counter).toBe(fixture.expected.manifest.counter);
      }
      expect(Object.keys(artifacts.modes).sort()).toEqual([...(fixture.expected.modes ?? [])].sort());
      for (const [mode, block] of Object.entries(fixture.expected.blocks ?? {})) {
        expect(artifacts.modes[mode]).toBe(block);
      }
      if (fixture.expected.content_hash !== undefined) expect(artifacts.manifest.content_hash).toBe(fixture.expected.content_hash);
      for (const [mode, hash] of Object.entries(fixture.expected.mode_hashes ?? {})) {
        expect(artifacts.manifest.modes[mode]?.sha256).toBe(hash);
      }
      for (const [mode, bytes] of Object.entries(fixture.expected.mode_bytes ?? {})) {
        expect(artifacts.manifest.modes[mode]?.bytes).toBe(bytes);
      }
      for (const [mode, tokens] of Object.entries(fixture.expected.mode_tokens ?? {})) {
        expect(artifacts.manifest.modes[mode]?.tokens).toBe(tokens);
      }
      for (const [mode, voiceHint] of Object.entries(fixture.expected.mode_voice_hints ?? {})) {
        expect(artifacts.manifest.modes[mode]?.voice_hint).toBe(voiceHint);
      }
      if (fixture.expected.triggers !== undefined) expect(artifacts.triggers).toEqual(fixture.expected.triggers);
      if (fixture.expected.policy !== undefined) expect(artifacts.policy).toEqual(fixture.expected.policy);
    });
  }
});

describe("build output semantics", () => {
  function buildTree(directory: string, prefix = ""): Record<string, string> {
    const tree: Record<string, string> = {};
    for (const entry of readdirSync(resolve(directory, prefix), { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) Object.assign(tree, buildTree(directory, path));
      else tree[path] = readFileSync(resolve(directory, path)).toString("hex");
    }
    return tree;
  }

  it("writes byte-identical mode files on repeated builds", () => {
    const fixture = resolve(casesRoot, "rendering-golden");
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-build-determinism-"));
    try {
      const firstOutput = resolve(temporary, "first");
      const secondOutput = resolve(temporary, "second");
      const options = { packDir: fixture, builtAt: fixedTime, outputDir: firstOutput, engineVersion: "0.1.0" };
      expect(buildPack(options).ok).toBe(true);
      expect(buildPack({ ...options, outputDir: secondOutput }).ok).toBe(true);
      expect(readFileSync(resolve(firstOutput, "modes/dummy.md")))
        .toEqual(readFileSync(resolve(secondOutput, "modes/dummy.md")));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("does not update an existing build when compilation fails", () => {
    const fixture = resolve(casesRoot, "error-schema-version");
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-build-atomic-"));
    const output = resolve(temporary, "build");
    try {
      // A sentinel file stands in for the prior complete build.
      expect(readdirSync(temporary)).toEqual([]);
      writeFileSync(resolve(temporary, "sentinel"), "outside");
      const validFixture = resolve(casesRoot, "minimal-pack");
      expect(buildPack({ packDir: validFixture, outputDir: output, builtAt: fixedTime, engineVersion: "0.1.0" }).ok).toBe(true);
      const previous = buildTree(output);
      expect(buildPack({ packDir: fixture, outputDir: output, builtAt: fixedTime, engineVersion: "0.1.0" }).ok).toBe(false);
      expect(buildTree(output)).toEqual(previous);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("restores the previous build and throws when the publish rename fails", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-build-publish-fault-"));
    const output = resolve(temporary, "build");
    try {
      const initialFixture = resolve(casesRoot, "minimal-pack");
      const replacementFixture = resolve(casesRoot, "rendering-golden");
      expect(buildPack({ packDir: initialFixture, outputDir: output, builtAt: fixedTime, engineVersion: "0.1.0" }).ok).toBe(true);
      const previous = buildTree(output);

      fsFault.publishDestination = output;
      expect(() => buildPack({
        packDir: replacementFixture,
        outputDir: output,
        builtAt: "2026-01-02T00:00:00.000Z",
        engineVersion: "0.1.0",
      })).toThrow("injected publish rename failure");
      expect(buildTree(output)).toEqual(previous);
    } finally {
      fsFault.publishDestination = undefined;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps the new build live when backup cleanup fails", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-build-cleanup-fault-"));
    const expectedOutput = resolve(temporary, "expected");
    const output = resolve(temporary, "build");
    try {
      const initialFixture = resolve(casesRoot, "minimal-pack");
      const replacementFixture = resolve(casesRoot, "rendering-golden");
      const replacementOptions = {
        packDir: replacementFixture,
        builtAt: "2026-01-02T00:00:00.000Z",
        engineVersion: "0.1.0",
      };
      expect(buildPack({ ...replacementOptions, outputDir: expectedOutput }).ok).toBe(true);
      expect(buildPack({ packDir: initialFixture, outputDir: output, builtAt: fixedTime, engineVersion: "0.1.0" }).ok).toBe(true);

      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fsFault.cleanupBackup = true;
      expect(() => buildPack({ ...replacementOptions, outputDir: output })).not.toThrow();
      expect(buildTree(output)).toEqual(buildTree(expectedOutput));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("failed to remove stale build backup"));
    } finally {
      fsFault.cleanupBackup = false;
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("build error code catalog", () => {
  it("stays in sync with SPEC §4.1 (24 codes)", () => {
    expect(BUILD_ERROR_CODES).toHaveLength(24);
  });
});
