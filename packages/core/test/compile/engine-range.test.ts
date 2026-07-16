import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { compilePack } from "../../src/compile/index.js";

function writeMinimalPack(root: string, min: string, max: string | null): void {
  mkdirSync(resolve(root, "modes"), { recursive: true });
  writeFileSync(resolve(root, "manifest.yml"), [
    "schema_version: 2",
    'pack_version: "0.0.0"',
    "name: engine-range-pack",
    "engine:",
    `  min: "${min}"`,
    `  max: ${max === null ? "null" : `"${max}"`}`,
    "",
  ].join("\n"));
  writeFileSync(resolve(root, "modes/dummy.yml"), "sections:\n  - id: dummy\n    text: dummy text\n");
}

it("emits the declared bounded engine range", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "persona-engine-range-bounded-"));
  try {
    writeMinimalPack(temporary, "0.2.0", "0.9.0");
    const result = compilePack({ packDir: temporary, engineVersion: "0.5.0" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifacts.manifest.engine_range).toEqual({ min: "0.2.0", max: "0.9.0" });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it("emits null for an unbounded engine range maximum", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "persona-engine-range-unbounded-"));
  try {
    writeMinimalPack(temporary, "0.1.0", null);
    const result = compilePack({ packDir: temporary, engineVersion: "0.5.0" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifacts.manifest.engine_range).toEqual({ min: "0.1.0", max: null });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
