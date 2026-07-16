import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { compilePack } from "../../src/compile/index.js";
import { parseSafeYaml, SafeYamlError } from "../../src/compile/yaml.js";

function writeMinimalPack(root: string, modeBody: string): void {
  mkdirSync(resolve(root, "modes"), { recursive: true });
  writeFileSync(resolve(root, "manifest.yml"), [
    "schema_version: 2",
    'pack_version: "0.0.0"',
    "name: safety-pack",
    "engine:",
    '  min: "0.1.0"',
    "  max: null",
    "",
  ].join("\n"));
  writeFileSync(resolve(root, "modes/dummy.yml"), modeBody);
}

describe("safe compiler inputs", () => {
  it("rejects unknown YAML tags instead of constructing tagged values", () => {
    expect(() => parseSafeYaml("value: !unknown dummy\n")).toThrow(SafeYamlError);
  });

  it("maps unknown tags to the documented parse error", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-yaml-safety-"));
    try {
      const manifestPack = resolve(temporary, "manifest-pack");
      writeMinimalPack(manifestPack, "sections:\n  - id: dummy\n    text: dummy text\n");
      writeFileSync(resolve(manifestPack, "manifest.yml"), "schema_version: !unknown 2\n");
      const manifestResult = compilePack({ packDir: manifestPack, engineVersion: "0.1.0" });
      expect(manifestResult.ok).toBe(false);
      if (!manifestResult.ok) expect(manifestResult.errors.map((error) => error.code)).toContain("E_PARSE");

      const modePack = resolve(temporary, "mode-pack");
      writeMinimalPack(modePack, "sections: !unknown []\n");
      const modeResult = compilePack({ packDir: modePack, engineVersion: "0.1.0" });
      expect(modeResult.ok).toBe(false);
      if (!modeResult.ok) expect(modeResult.errors.map((error) => error.code)).toContain("E_PARSE");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("maps non-map top-level YAML documents to the documented parse error", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-yaml-shape-safety-"));
    try {
      const manifestPack = resolve(temporary, "manifest-pack");
      writeMinimalPack(manifestPack, "sections:\n  - id: dummy\n    text: dummy text\n");
      writeFileSync(resolve(manifestPack, "manifest.yml"), "[]\n");
      const manifestResult = compilePack({ packDir: manifestPack, engineVersion: "0.1.0" });
      expect(manifestResult.ok).toBe(false);
      if (!manifestResult.ok) expect(manifestResult.errors.map((error) => error.code)).toContain("E_PARSE");

      const modePack = resolve(temporary, "mode-pack");
      writeMinimalPack(modePack, "[]\n");
      const modeResult = compilePack({ packDir: modePack, engineVersion: "0.1.0" });
      expect(modeResult.ok).toBe(false);
      if (!modeResult.ok) expect(modeResult.errors.map((error) => error.code)).toContain("E_PARSE");

      const installPack = resolve(temporary, "install-pack");
      writeMinimalPack(installPack, "sections:\n  - id: dummy\n    text: dummy text\n");
      const installPath = resolve(temporary, "install.yml");
      writeFileSync(installPath, "[]\n");
      const installResult = compilePack({ packDir: installPack, installFile: installPath, engineVersion: "0.1.0" });
      expect(installResult.ok).toBe(false);
      if (!installResult.ok) expect(installResult.errors.map((error) => error.code)).toContain("E_PARSE");

      const aliasesPack = resolve(temporary, "aliases-pack");
      writeMinimalPack(aliasesPack, "sections:\n  - id: dummy\n    text: dummy text\n");
      writeFileSync(resolve(aliasesPack, "aliases.yml"), "[]\n");
      const aliasesResult = compilePack({ packDir: aliasesPack, engineVersion: "0.1.0" });
      expect(aliasesResult.ok).toBe(false);
      if (!aliasesResult.ok) expect(aliasesResult.errors.map((error) => error.code)).toContain("E_PARSE");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("classifies an uninterpretable aliases field as a parse error", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-alias-shape-safety-"));
    try {
      writeMinimalPack(temporary, "sections:\n  - id: dummy\n    text: dummy text\n");
      writeFileSync(resolve(temporary, "aliases.yml"), "foo: bar\n");
      const result = compilePack({ packDir: temporary, engineVersion: "0.1.0" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.code)).toContain("E_PARSE");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("classifies malformed per-mode alias lists as parse errors, not collisions", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-alias-entry-safety-"));
    try {
      writeMinimalPack(temporary, "sections:\n  - id: dummy\n    text: dummy text\n");
      writeFileSync(resolve(temporary, "aliases.yml"), "aliases:\n  dummy: not-a-list\n");
      const result = compilePack({ packDir: temporary, engineVersion: "0.1.0" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((error) => error.code)).toContain("E_PARSE");
        expect(result.errors.map((error) => error.code)).not.toContain("E_ALIAS_COLLISION");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects catalog symlink escapes", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-catalog-safety-"));
    try {
      const pack = resolve(temporary, "pack");
      const outside = resolve(temporary, "outside.txt");
      writeFileSync(outside, "outside dummy text");
      mkdirSync(resolve(pack, "catalogs"), { recursive: true });
      symlinkSync(outside, resolve(pack, "catalogs/escape.txt"));
      writeMinimalPack(pack, [
        "catalog_refs:",
        "  - id: escaped",
        "    path: catalogs/escape.txt",
        "    priority: 0",
        "",
      ].join("\n"));

      const result = compilePack({ packDir: pack, engineVersion: "0.1.0" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.code)).toContain("E_CATALOG_REF");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects audit directory symlink escapes", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-audit-safety-"));
    try {
      const pack = resolve(temporary, "pack");
      const installRoot = resolve(temporary, "install");
      const outside = resolve(temporary, "outside");
      mkdirSync(installRoot, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, resolve(installRoot, "audit-link"));
      writeMinimalPack(pack, "sections:\n  - id: dummy\n    text: dummy text\n");
      const install = resolve(installRoot, "install.yml");
      writeFileSync(install, [
        "schema_version: 2",
        `pack: ${pack}`,
        "runtime: generic",
        "routes: []",
        "audit:",
        "  dir: audit-link",
        "",
      ].join("\n"));

      const result = compilePack({ packDir: pack, installFile: install, engineVersion: "0.1.0" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.code)).toContain("E_AUDIT_DIR");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects dangling audit directory symlinks", () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "persona-audit-dangling-safety-"));
    try {
      const pack = resolve(temporary, "pack");
      const installRoot = resolve(temporary, "install");
      mkdirSync(installRoot, { recursive: true });
      symlinkSync(resolve(temporary, "does-not-exist"), resolve(installRoot, "audit-link"));
      writeMinimalPack(pack, "sections:\n  - id: dummy\n    text: dummy text\n");
      const install = resolve(installRoot, "install.yml");
      writeFileSync(install, [
        "schema_version: 2",
        `pack: ${pack}`,
        "runtime: generic",
        "routes: []",
        "audit:",
        "  dir: audit-link",
        "",
      ].join("\n"));

      const result = compilePack({ packDir: pack, installFile: install, engineVersion: "0.1.0" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.code)).toContain("E_AUDIT_DIR");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
