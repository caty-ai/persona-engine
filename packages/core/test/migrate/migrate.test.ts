import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as YAML from "yaml";

import {
  migrate,
  type MigrateReport,
} from "../../src/migrate/index.js";

// migrate stamps engine.min with the current engine version; derive it like
// the CLI does instead of hard-coding (broke on the 0.0.0 -> 0.1.0 bump)
const ENGINE_VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
    version: string;
  }
).version;

interface GeneratedMode {
  voice_hint?: string;
  extends?: string;
  budget_tokens?: number;
  sections: Array<{ id: string; text: string }>;
  catalog_refs?: Array<{ path: string; id: string; priority: number }>;
}

describe("migrate", () => {
  let temporaryRoot: string;
  let v1Root: string;
  let outputRoot: string;
  let report: MigrateReport;

  const description = "A friendly test persona.\n  Preserve this indentation.\n";
  const personalityNotes = "Patient and kind.\nLeaves the final newline intact.\n";
  const catalogBytes = Buffer.from(
    "catalog_id: greetings\r\npayload: placeholder-only\r\n",
    "utf8",
  );

  beforeAll(async () => {
    temporaryRoot = mkdtempSync(resolve(tmpdir(), "persona-migrate-test-"));
    v1Root = resolve(temporaryRoot, "v1-source");
    outputRoot = resolve(temporaryRoot, "Output Pack");

    mkdirSync(resolve(v1Root, "modes"), { recursive: true });
    mkdirSync(resolve(v1Root, "catalogs/common"), { recursive: true });

    writeFileSync(
      resolve(v1Root, "index.yml"),
      YAML.stringify({
        version: 1,
        default_mode: "public",
        modes: [
          {
            id: "friendly-mode",
            file: "modes/friendly-mode.yml",
            triggers: {
              explicit: ["Switch Friendly", "Friendly now"],
            },
            priority: 10,
          },
          {
            id: "formal-mode",
            file: "modes/formal-mode.yml",
            triggers: {
              explicit: ["  SWITCH　FRIENDLY  ", "/persona formal-mode"],
            },
            priority: 20,
          },
          {
            id: "quiet-mode",
            file: "modes/quiet-mode.yml",
            triggers: {
              auto: {
                keywords: ["dummy keyword"],
                conditions: ["dummy condition"],
              },
            },
            priority: 5,
          },
          {
            id: "constructor",
            file: "modes/constructor.yml",
            triggers: {
              explicit: ["Use constructor"],
            },
          },
          {
            id: "public",
            file: "modes/public.yml",
            triggers: {
              explicit: ["Return Public"],
            },
            priority: 0,
          },
        ],
      }),
      "utf8",
    );

    writeFileSync(
      resolve(v1Root, "modes/friendly-mode.yml"),
      YAML.stringify({
        id: "friendly-mode",
        label: "Friendly mode",
        description,
        voice: {
          mode: "inherit",
          tone: "warm",
          sentence_endings: { add: ["okay"] },
        },
        vocabulary: {
          catalog_refs: [
            {
              catalog: "common/greetings",
              sections: ["sample"],
            },
          ],
        },
        addressing: {
          "{{owner-name}}": "friend",
        },
        character: {
          personality_notes: personalityNotes,
          physical_mannerisms: ["smiles"],
        },
        visual: {
          mood_emoji: "🙂",
        },
        meta: {
          author: "fixture-author",
        },
      }),
      "utf8",
    );

    writeFileSync(
      resolve(v1Root, "modes/formal-mode.yml"),
      YAML.stringify({
        id: "formal-mode",
        label: "Formal mode",
        description: "A formal test persona.\n",
        voice: {
          mode: "override",
          tone: "formal",
          sentence_endings: ["indeed", "certainly"],
        },
        vocabulary: {
          catalog_refs: [{ catalog: "common/link.yml" }],
        },
        addressing: {
          "{{owner-name}}": "colleague",
        },
      }),
      "utf8",
    );

    writeFileSync(
      resolve(v1Root, "modes/quiet-mode.yml"),
      YAML.stringify({
        id: "quiet-mode",
        label: "Quiet mode",
        description: "A quiet test persona.\n",
        voice: {
          mode: "override",
          tone: "quiet",
          sentence_endings: ["noted", "understood"],
        },
        addressing: {
          "{{owner-name}}": "friend",
        },
      }),
      "utf8",
    );

    writeFileSync(
      resolve(v1Root, "modes/constructor.yml"),
      YAML.stringify({
        id: "constructor",
        label: "Constructor mode",
        description: "A prototype-safe test persona.\n",
        voice: {
          mode: "override",
          tone: "precise",
          sentence_endings: ["done", "verified"],
        },
        addressing: {
          "{{owner-name}}": "reviewer",
        },
      }),
      "utf8",
    );

    // Deliberately invalid YAML proves the reserved v1 mode is skipped before parsing.
    writeFileSync(resolve(v1Root, "modes/public.yml"), "[\n", "utf8");
    writeFileSync(resolve(v1Root, "catalogs/common/greetings.yml"), catalogBytes);
    writeFileSync(resolve(v1Root, "not-a-catalog.yml"), "outside: true\n", "utf8");
    symlinkSync(
      "../../not-a-catalog.yml",
      resolve(v1Root, "catalogs/common/link.yml"),
    );

    report = await migrate(v1Root, outputRoot);
  });

  afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("emits the v2 pack skeleton and converted envelopes", () => {
    expect(readdirSync(outputRoot).sort()).toEqual([
      "aliases.yml",
      "catalogs",
      "manifest.yml",
      "modes",
    ]);
    expect(readdirSync(resolve(outputRoot, "modes")).sort()).toEqual([
      "constructor.yml",
      "formal-mode.yml",
      "friendly-mode.yml",
      "quiet-mode.yml",
    ]);

    const manifest = parseYaml<Record<string, unknown>>(resolve(outputRoot, "manifest.yml"));
    expect(manifest).toEqual({
      schema_version: 2,
      pack_version: "0.1.0",
      name: "output-pack",
      engine: {
        min: ENGINE_VERSION,
        max: null,
      },
    });

    const friendly = parseYaml<GeneratedMode>(
      resolve(outputRoot, "modes/friendly-mode.yml"),
    );
    expect(friendly.voice_hint).toBe("Friendly mode");
    expect(friendly.extends).toBeUndefined();
    expect(friendly.budget_tokens).toBeUndefined();
    expect(friendly.sections.map(({ id }) => id)).toEqual([
      "description",
      "voice",
      "addressing",
      "character-personality-notes",
      "character",
      "visual",
    ]);
    expect(YAML.parse(sectionText(friendly, "voice"))).toEqual({
      sentence_endings: { add: ["okay"] },
      tone: "warm",
    });
    expect(friendly.catalog_refs).toEqual([
      {
        path: "catalogs/common/greetings.yml",
        id: "catalog-1",
        priority: 10,
      },
    ]);

    const aliases = parseYaml<{ aliases: Record<string, string[]> }>(
      resolve(outputRoot, "aliases.yml"),
    );
    expect(aliases).toEqual({
      aliases: {
        constructor: ["Use constructor"],
        "friendly-mode": ["Friendly now"],
        public: ["Return Public"],
      },
    });

    expect(report.modes).toEqual({
      count: 4,
      ids: ["friendly-mode", "formal-mode", "quiet-mode", "constructor"],
    });
    expect(report.aliases.count).toBe(3);
    expect(report.catalogs).toEqual({
      filesCopied: 1,
      bytesCopied: catalogBytes.byteLength,
    });
    expect(() => readFileSync(resolve(outputRoot, "catalogs/common/link.yml"))).toThrow();
  });

  it("preserves catalog bytes exactly", () => {
    const copiedCatalog = readFileSync(
      resolve(outputRoot, "catalogs/common/greetings.yml"),
    );
    expect(sha256(copiedCatalog)).toBe(sha256(catalogBytes));
  });

  it("preserves hand-authored YAML scalar values across line endings, chomping, quoting, and Unicode", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "scalar-fidelity-");
    writeFixtureIndex(fixture.v1Root, [
      { id: "crlf-mode", file: "modes/crlf-mode.yml" },
      { id: "lf-mode", file: "modes/lf-mode.yml" },
    ]);

    const crlfModeSource = "id: crlf-mode\r\ndescription: |-\r\n  line one\r\n  line two\r\ncharacter:\r\n  personality_notes: |\r\n    日本語🙂\r\n";
    const lfModeSource = "id: lf-mode\ndescription: \"line one\\nline two\"\ncharacter:\n  personality_notes: |-\n    日本語🙂\n";
    writeFileSync(resolve(fixture.v1Root, "modes/crlf-mode.yml"), crlfModeSource, "utf8");
    writeFileSync(resolve(fixture.v1Root, "modes/lf-mode.yml"), lfModeSource, "utf8");

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);
    const crlfMode = parseYaml<GeneratedMode>(
      resolve(fixture.outputRoot, "modes/crlf-mode.yml"),
    );
    const lfMode = parseYaml<GeneratedMode>(
      resolve(fixture.outputRoot, "modes/lf-mode.yml"),
    );

    expect(sectionText(crlfMode, "description")).toBe("line one\nline two");
    expect(sectionText(lfMode, "description")).toBe("line one\nline two");
    expect(sectionText(crlfMode, "character-personality-notes")).toBe("日本語🙂\n");
    expect(sectionText(lfMode, "character-personality-notes")).toBe("日本語🙂");
    expect(fixtureReport.warnings).toContainEqual(expect.objectContaining({
      kind: "line-ending-normalized",
      modeId: "crlf-mode",
    }));
    expect(fixtureReport.warnings).not.toContainEqual(expect.objectContaining({
      kind: "line-ending-normalized",
      modeId: "lf-mode",
    }));
  });

  it("warns and continues when a mode file contains invalid UTF-8", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "invalid-mode-utf8-");
    writeFixtureIndex(fixture.v1Root, [
      { id: "invalid-bytes", file: "modes/invalid-bytes.yml" },
    ]);
    const invalidModeBytes = Buffer.concat([
      Buffer.from("id: invalid-bytes\ndescription: \"before ", "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(" after\"\n", "utf8"),
    ]);
    writeFileSync(resolve(fixture.v1Root, "modes/invalid-bytes.yml"), invalidModeBytes);

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);
    const migratedMode = parseYaml<GeneratedMode>(
      resolve(fixture.outputRoot, "modes/invalid-bytes.yml"),
    );

    expect(sectionText(migratedMode, "description")).toBe("before �( after");
    expect(fixtureReport.warnings).toContainEqual(expect.objectContaining({
      kind: "invalid-utf8",
      modeId: "invalid-bytes",
      detail: expect.stringContaining("U+FFFD"),
    }));
  });

  it("warns before omitting wrong-shaped and unsupported nested mode fields", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "mode-field-warnings-");
    writeFixtureIndex(fixture.v1Root, [
      { id: "wrong-shapes", file: "modes/wrong-shapes.yml" },
      { id: "nested-shapes", file: "modes/nested-shapes.yml" },
      { id: "bad-ref-array", file: "modes/bad-ref-array.yml" },
    ]);
    writeFileSync(
      resolve(fixture.v1Root, "modes/wrong-shapes.yml"),
      YAML.stringify({
        id: "wrong-shapes",
        label: ["not", "a string"],
        description: 42,
        voice: "not a mapping",
        addressing: ["not a mapping"],
        visual: false,
        character: "not a mapping",
        vocabulary: "not a mapping",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(fixture.v1Root, "modes/nested-shapes.yml"),
      YAML.stringify({
        id: "nested-shapes",
        character: { personality_notes: ["not", "a string"] },
        vocabulary: {
          notes: "unsupported vocabulary metadata",
          catalog_refs: [{
            catalog: "invalid.yml",
            sections: ["all"],
            notes: "unsupported reference metadata",
          }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      resolve(fixture.v1Root, "modes/bad-ref-array.yml"),
      YAML.stringify({
        id: "bad-ref-array",
        vocabulary: { catalog_refs: "not an array" },
      }),
      "utf8",
    );
    const invalidCatalogBytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    writeFileSync(resolve(fixture.v1Root, "catalogs/invalid.yml"), invalidCatalogBytes);

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);
    const warningDetails = fixtureReport.warnings
      .filter(({ kind }) => kind === "invalid-field-type")
      .map(({ detail }) => detail);
    const nestedMode = parseYaml<GeneratedMode>(
      resolve(fixture.outputRoot, "modes/nested-shapes.yml"),
    );

    for (const field of [
      "description",
      "label",
      "voice",
      "addressing",
      "visual",
      "character",
      "vocabulary",
      "character.personality_notes",
      "vocabulary.catalog_refs",
    ]) {
      expect(warningDetails).toContainEqual(expect.stringContaining(`'${field}'`));
    }
    expect(fixtureReport.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "unsupported-vocabulary-field",
        modeId: "nested-shapes",
        detail: expect.stringContaining("'notes'"),
      }),
      expect.objectContaining({
        kind: "unsupported-catalog-ref-field",
        modeId: "nested-shapes",
        detail: expect.stringContaining("'notes'"),
      }),
      expect.objectContaining({
        kind: "catalog-ref-invalid-utf8",
        modeId: "nested-shapes",
      }),
    ]));
    expect(nestedMode.catalog_refs).toBeUndefined();
    expect(readFileSync(resolve(fixture.outputRoot, "catalogs/invalid.yml"))).toEqual(
      invalidCatalogBytes,
    );
  });

  it("reports unsupported triggers, the reserved mode, and alias collisions without content", () => {
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "unsupported-auto-trigger",
        modeId: "quiet-mode",
        detail: expect.stringContaining("'keywords'"),
      }),
      expect.objectContaining({
        kind: "unsupported-auto-trigger",
        modeId: "quiet-mode",
        detail: expect.stringContaining("'conditions'"),
      }),
      expect.objectContaining({
        kind: "E_RESERVED_MODE",
        modeId: "public",
      }),
      expect.objectContaining({
        kind: "E_ALIAS_RESERVED",
        modeId: "formal-mode",
      }),
      expect.objectContaining({
        kind: "E_ALIAS_COLLISION",
        modeId: "friendly-mode",
      }),
      expect.objectContaining({
        kind: "E_ALIAS_COLLISION",
        modeId: "formal-mode",
      }),
      expect.objectContaining({
        kind: "inherit-base-unmapped",
        modeId: "friendly-mode",
      }),
      expect.objectContaining({
        kind: "catalog-sections-unsupported",
        modeId: "friendly-mode",
      }),
      expect.objectContaining({
        kind: "E_CATALOG_REF",
        modeId: "formal-mode",
      }),
      expect.objectContaining({
        kind: "unsupported-catalog-entry",
      }),
    ]));

    const warningJson = JSON.stringify(report.warnings);
    expect(warningJson).not.toContain("Switch Friendly");
    expect(warningJson).not.toContain("dummy keyword");
    expect(warningJson).not.toContain("dummy condition");
    expect(() => readFileSync(resolve(outputRoot, "modes/public.yml"))).toThrow();
  });

  it("rejects input/output overlap through canonical paths", async () => {
    const sourceAlias = resolve(temporaryRoot, "v1-source-alias");
    symlinkSync(v1Root, sourceAlias, "dir");

    await expect(
      migrate(sourceAlias, resolve(v1Root, "nested-output")),
    ).rejects.toThrow("output directory must not be the v1 directory or a descendant");
    await expect(migrate(v1Root, temporaryRoot)).rejects.toThrow(
      "output directory must not be an ancestor of the v1 directory",
    );
  });

  it("rejects mode paths that escape the v1 modes directory", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "mode-path-escape-");
    writeFixtureIndex(fixture.v1Root, [
      {
        id: "escaped-mode",
        file: "modes/../outside-mode.yml",
      },
    ]);
    writeFileSync(
      resolve(fixture.v1Root, "outside-mode.yml"),
      YAML.stringify({ id: "escaped-mode", description: "Fixture-only description.\n" }),
      "utf8",
    );

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);

    expect(fixtureReport.modes).toEqual({ count: 0, ids: [] });
    expect(fixtureReport.warnings).toContainEqual(expect.objectContaining({
      kind: "mode-path-invalid",
      modeId: "escaped-mode",
    }));
    expect(readdirSync(resolve(fixture.outputRoot, "modes"))).toEqual([]);
  });

  it("rejects catalog refs that escape the v1 catalogs directory", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "catalog-path-escape-");
    writeFixtureIndex(fixture.v1Root, [
      {
        id: "catalog-mode",
        file: "modes/catalog-mode.yml",
      },
    ]);
    writeFileSync(
      resolve(fixture.v1Root, "modes/catalog-mode.yml"),
      YAML.stringify({
        id: "catalog-mode",
        vocabulary: {
          catalog_refs: [{ catalog: "../outside-catalog.yml" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      resolve(fixture.v1Root, "outside-catalog.yml"),
      YAML.stringify({ fixture: true }),
      "utf8",
    );

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);
    const migratedMode = parseYaml<GeneratedMode>(
      resolve(fixture.outputRoot, "modes/catalog-mode.yml"),
    );

    expect(fixtureReport.warnings).toContainEqual(expect.objectContaining({
      kind: "E_CATALOG_REF",
      modeId: "catalog-mode",
    }));
    expect(migratedMode.catalog_refs).toBeUndefined();
  });

  it("rejects an output directory that already exists", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "existing-output-");
    mkdirSync(fixture.outputRoot);

    await expect(migrate(fixture.v1Root, fixture.outputRoot)).rejects.toThrow(
      "output directory must not already exist",
    );
  });

  it("removes the staging directory after a mid-migration failure", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "staging-cleanup-");
    writeFixtureIndex(fixture.v1Root, [
      {
        id: "broken-mode",
        file: "modes/broken-mode.yml",
      },
    ]);
    writeFileSync(resolve(fixture.v1Root, "modes/broken-mode.yml"), "[\n", "utf8");
    const stagingPrefix = `.${basename(fixture.outputRoot)}.migrate-`;
    const stagingEntries = () => readdirSync(fixture.root)
      .filter((entry) => entry.startsWith(stagingPrefix));

    expect(stagingEntries()).toEqual([]);
    await expect(migrate(fixture.v1Root, fixture.outputRoot)).rejects.toThrow(
      "failed to parse YAML mapping",
    );
    expect(stagingEntries()).toEqual([]);
    expect(existsSync(fixture.outputRoot)).toBe(false);
  });

  it("skips the second of two index entries with the same mode id", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "duplicate-mode-id-");
    writeFixtureIndex(fixture.v1Root, [
      {
        id: "shared-mode",
        file: "modes/first.yml",
      },
      {
        id: "shared-mode",
        file: "modes/second.yml",
      },
    ]);
    writeFileSync(
      resolve(fixture.v1Root, "modes/first.yml"),
      YAML.stringify({ id: "shared-mode", description: "First fixture mode.\n" }),
      "utf8",
    );
    writeFileSync(
      resolve(fixture.v1Root, "modes/second.yml"),
      YAML.stringify({ id: "shared-mode", voice: { tone: "second-fixture" } }),
      "utf8",
    );

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);
    const migratedMode = parseYaml<GeneratedMode>(
      resolve(fixture.outputRoot, "modes/shared-mode.yml"),
    );

    expect(fixtureReport.modes).toEqual({ count: 1, ids: ["shared-mode"] });
    expect(fixtureReport.warnings).toContainEqual(expect.objectContaining({
      kind: "mode-id-duplicate",
      modeId: "shared-mode",
    }));
    expect(migratedMode.sections.map(({ id }) => id)).toEqual(["description"]);
  });

  it("rejects aliases that target a skipped mode", async () => {
    const fixture = createSafetyFixture(temporaryRoot, "skipped-mode-alias-");
    writeFixtureIndex(fixture.v1Root, [
      {
        id: "skipped-mode",
        file: "modes/missing.yml",
        triggers: {
          explicit: ["Activate skipped fixture"],
        },
      },
    ]);

    const fixtureReport = await migrate(fixture.v1Root, fixture.outputRoot);
    const aliases = parseYaml<{ aliases: Record<string, string[]> }>(
      resolve(fixture.outputRoot, "aliases.yml"),
    );

    expect(fixtureReport.modes).toEqual({ count: 0, ids: [] });
    expect(fixtureReport.aliases.count).toBe(0);
    expect(fixtureReport.warnings).toContainEqual(expect.objectContaining({
      kind: "E_ALIAS_UNKNOWN_MODE",
      modeId: "skipped-mode",
    }));
    expect(aliases.aliases["skipped-mode"]).toBeUndefined();
  });
});

function createSafetyFixture(parent: string, prefix: string): {
  root: string;
  v1Root: string;
  outputRoot: string;
} {
  const root = mkdtempSync(resolve(parent, prefix));
  const v1Root = resolve(root, "v1");
  mkdirSync(resolve(v1Root, "modes"), { recursive: true });
  mkdirSync(resolve(v1Root, "catalogs"), { recursive: true });
  return {
    root,
    v1Root,
    outputRoot: resolve(root, "generated-pack"),
  };
}

function writeFixtureIndex(v1Root: string, modes: unknown[]): void {
  writeFileSync(
    resolve(v1Root, "index.yml"),
    YAML.stringify({ version: 1, modes }),
    "utf8",
  );
}

function parseYaml<T>(path: string): T {
  return YAML.parse(readFileSync(path, "utf8")) as T;
}

function sectionText(mode: GeneratedMode, id: string): string {
  const section = mode.sections.find((candidate) => candidate.id === id);
  if (section === undefined) {
    throw new Error(`missing generated section: ${id}`);
  }
  return section.text;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
