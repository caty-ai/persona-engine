import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import * as YAML from "yaml";

const MODE_ID_PATTERN = /^[a-z0-9-]+$/;
const ASCII_UPPERCASE_PATTERN = /[A-Z]/g;
const WHITESPACE_PATTERN = /\s+/g;

export interface MigrateNotice {
  kind: string;
  modeId?: string;
  detail: string;
}

export interface MigrateDecision {
  kind: string;
  detail: string;
}

export interface MigrateReport {
  modes: {
    count: number;
    ids: string[];
  };
  aliases: {
    count: number;
  };
  catalogs: {
    filesCopied: number;
    bytesCopied: number;
  };
  manifest: {
    name: string;
    packVersion: string;
    engineMin: string;
  };
  warnings: MigrateNotice[];
  decisions: MigrateDecision[];
}

interface V1IndexMode {
  id?: unknown;
  file?: unknown;
  priority?: unknown;
  triggers?: {
    explicit?: unknown;
    auto?: unknown;
  };
}

interface V1Index {
  version?: unknown;
  default_mode?: unknown;
  modes?: unknown;
}

interface V2Section {
  id: string;
  text: string;
}

interface V2CatalogRef {
  path: string;
  id: string;
  priority: number;
}

interface CatalogCopyStats {
  filesCopied: number;
  bytesCopied: number;
}

interface CatalogCopyResult extends CatalogCopyStats {
  copiedPaths: Set<string>;
}

interface CatalogResolution {
  path?: string;
  warning?: string;
}

interface AliasCandidate {
  modeId: string;
  normalized: string;
  value: string;
}

const MIGRATION_DECISIONS: MigrateDecision[] = [
  {
    kind: "manifest-defaults",
    detail: "pack name is the normalized output-directory basename, pack_version starts at 0.1.0, and engine.min comes from packages/core/package.json",
  },
  {
    kind: "public-sentinel",
    detail: "the v1 public mode file is not read or emitted because v2 reserves public as an implicit empty sentinel; explicit public aliases may still migrate",
  },
  {
    kind: "inheritance",
    detail: "v1 voice.mode is omitted; inherit does not emit extends because it referred to an out-of-pack base persona, while override needs no v2 inheritance marker",
  },
  {
    kind: "section-layout",
    detail: "description and character.personality_notes become direct text sections; voice, addressing, remaining character fields, and visual use deterministic YAML sections",
  },
  {
    kind: "mode-text-fidelity",
    detail: "mode-embedded text is preserved as decoded YAML scalar values, not source bytes; only catalogs are byte-identical via direct copy, while CR line endings and invalid UTF-8 in mode files produce per-mode warnings",
  },
  {
    kind: "catalog-layout",
    detail: "catalog paths resolve as exact files or unique .yml/.yaml matches; each emitted whole-file reference receives catalog-N id and priority in source-reference order because v2 cannot select internal catalog sections",
  },
  {
    kind: "metadata",
    detail: "label becomes read-only voice_hint; v1 meta, index priority, and non-public default_mode have no v2 envelope equivalents",
  },
  {
    kind: "aliases",
    detail: "explicit triggers retain their original strings; reserved, empty, unknown-target, and every member of a normalized collision class are skipped with structural warnings",
  },
  {
    kind: "unmapped-v1-settings",
    detail: "v1 config placeholders are outside migrate scope and are not read; budget_tokens is omitted because v1 has no equivalent",
  },
  {
    kind: "output-safety",
    detail: "migration uses an atomic sibling staging directory and requires the requested output path not to exist",
  },
];

export async function migrate(v1Dir: string, outDir: string): Promise<MigrateReport> {
  const requestedSourceRoot = resolve(v1Dir);
  const requestedOutputRoot = resolve(outDir);

  await assertDirectory(requestedSourceRoot, "v1 directory");
  const sourceRoot = await realpath(requestedSourceRoot);
  const outputRoot = await canonicalizeMissingPath(requestedOutputRoot);
  assertSeparateOutput(sourceRoot, outputRoot);
  await assertOutputAvailable(outputRoot);

  const packageVersion = await readCorePackageVersion();
  const packName = derivePackName(outputRoot);
  const notices: MigrateNotice[] = [];
  const indexPath = await resolveRequiredInputFile(
    join(sourceRoot, "index.yml"),
    sourceRoot,
    "index.yml",
  );
  const index = await parseYamlFile<V1Index>(indexPath);
  assertV1Index(index);
  const indexModes = parseIndexModes(index);

  const stagingRoot = await createStagingDirectory(outputRoot);

  try {
    const catalogStats = await copyCatalogTree(
      join(sourceRoot, "catalogs"),
      join(stagingRoot, "catalogs"),
      notices,
    );

    const aliasCandidates: AliasCandidate[] = [];
    const migratedModeIds: string[] = [];
    const seenModeIds = new Set<string>();

    await mkdir(join(stagingRoot, "modes"), { recursive: true });

    for (const entry of indexModes) {
      const modeId = readModeId(entry, notices);
      if (modeId === undefined) {
        continue;
      }
      if (seenModeIds.has(modeId)) {
        notices.push({
          kind: "mode-id-duplicate",
          modeId,
          detail: "duplicate index mode id was skipped to avoid overwriting an earlier migrated mode",
        });
        continue;
      }
      seenModeIds.add(modeId);

      reportUnsupportedAutoTriggers(entry, modeId, notices);
      reportPriority(entry, modeId, notices);

      // v2 owns `public` as an implicit empty sentinel. Do not even parse the v1
      // file: its base-persona payload has no pack-level destination in v2.
      if (modeId === "public") {
        notices.push({
          kind: "E_RESERVED_MODE",
          modeId,
          detail: "mode id 'public' is reserved as the empty v2 sentinel; its mode file was not read or migrated",
        });
      } else {
        const sourceModePath = await resolveModePath(sourceRoot, entry, modeId, notices);
        if (sourceModePath !== undefined) {
          const v1Mode = await parseModeYamlFile(sourceModePath, modeId, notices);
          const v2Mode = await convertMode(
            v1Mode,
            modeId,
            sourceRoot,
            catalogStats.copiedPaths,
            notices,
          );

          await writeYamlFile(join(stagingRoot, "modes", `${modeId}.yml`), v2Mode);
          migratedModeIds.push(modeId);
        }
      }

      migrateExplicitAliases(
        entry,
        modeId,
        aliasCandidates,
        notices,
      );
    }

    const aliases = finalizeAliases(
      aliasCandidates,
      new Set([...migratedModeIds, "public"]),
      notices,
    );

    const manifest = {
      schema_version: 2,
      pack_version: "0.1.0",
      name: packName,
      engine: {
        min: packageVersion,
        max: null,
      },
    };

    await writeYamlFile(join(stagingRoot, "manifest.yml"), manifest);
    await writeYamlFile(join(stagingRoot, "aliases.yml"), { aliases });

    reportIndexDefaults(index, notices);
    await publishStagingDirectory(stagingRoot, outputRoot);

    return {
      modes: {
        count: migratedModeIds.length,
        ids: migratedModeIds,
      },
      aliases: {
        count: Object.values(aliases).reduce((total, values) => total + values.length, 0),
      },
      catalogs: {
        filesCopied: catalogStats.filesCopied,
        bytesCopied: catalogStats.bytesCopied,
      },
      manifest: {
        name: packName,
        packVersion: "0.1.0",
        engineMin: packageVersion,
      },
      warnings: notices,
      decisions: MIGRATION_DECISIONS,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertSeparateOutput(sourceRoot: string, outputRoot: string): void {
  if (outputRoot === sourceRoot || outputRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("output directory must not be the v1 directory or a descendant of it");
  }
  if (sourceRoot.startsWith(`${outputRoot}${sep}`)) {
    throw new Error("output directory must not be an ancestor of the v1 directory");
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }

  if (!metadata.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

async function assertOutputAvailable(outputRoot: string): Promise<void> {
  try {
    await lstat(outputRoot);
    throw new Error(`output directory must not already exist: ${outputRoot}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function canonicalizeMissingPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      const existingRoot = await realpath(candidate);
      return resolve(existingRoot, ...missingSegments.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`could not resolve output path: ${path}`);
    }
    missingSegments.push(basename(candidate));
    candidate = parent;
  }
}

async function resolveRequiredInputFile(
  path: string,
  allowedRoot: string,
  label: string,
): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file within the v1 directory`);
  }

  const canonicalPath = await realpath(path);
  if (!isWithin(canonicalPath, allowedRoot)) {
    throw new Error(`${label} resolves outside the v1 directory`);
  }
  return canonicalPath;
}

async function createStagingDirectory(outputRoot: string): Promise<string> {
  const parent = dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = join(parent, `.${basename(outputRoot)}.migrate-${randomUUID()}`);
  await mkdir(stagingRoot);
  return stagingRoot;
}

async function publishStagingDirectory(stagingRoot: string, outputRoot: string): Promise<void> {
  await rename(stagingRoot, outputRoot);
}

async function readCorePackageVersion(): Promise<string> {
  const packageJsonPath = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new Error("packages/core/package.json must contain a string version");
  }

  return packageJson.version;
}

function derivePackName(outputRoot: string): string {
  const normalized = basename(outputRoot)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "migrated-persona";
}

async function parseYamlFile<T>(path: string): Promise<T> {
  const source = await readFile(path, "utf8");
  return parseYamlSource<T>(source, path);
}

/**
 * Mode text is preserved at the decoded YAML scalar-value level, not as the
 * original source bytes. YAML block scalars normalize CR/CRLF line breaks, and
 * lossy UTF-8 decoding can introduce U+FFFD. Only catalogs retain byte identity
 * because their files are copied directly without decoding or serialization.
 */
async function parseModeYamlFile(
  path: string,
  modeId: string,
  notices: MigrateNotice[],
): Promise<Record<string, unknown>> {
  const bytes = await readFile(path);
  if (bytes.includes(0x0d)) {
    notices.push({
      kind: "line-ending-normalized",
      modeId,
      detail: "CRLF or bare-CR line endings were found in the source mode file; YAML block-scalar serialization normalizes them to LF, so decoded text values are preserved but emitted section bytes may differ",
    });
  }

  let source: string;
  try {
    source = decodeUtf8Strict(bytes);
  } catch {
    notices.push({
      kind: "invalid-utf8",
      modeId,
      detail: "the v1 mode file contains invalid UTF-8 byte sequences; lossy decoding may substitute U+FFFD for original bytes, and SPEC §2.2 requires valid UTF-8 section and catalog text, so the source must be corrected before validation and persona build",
    });
    source = bytes.toString("utf8");
  }

  return parseYamlSource<Record<string, unknown>>(source, path);
}

function parseYamlSource<T>(source: string, path: string): T {
  let value: unknown;
  try {
    value = YAML.parse(source, { maxAliasCount: 100 }) as unknown;
  } catch {
    throw new Error(`failed to parse YAML mapping: ${basename(path)}`);
  }

  if (!isPlainRecord(value)) {
    throw new Error(`expected YAML mapping: ${path}`);
  }

  return value as T;
}

function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseIndexModes(index: V1Index): V1IndexMode[] {
  if (!Array.isArray(index.modes)) {
    throw new Error("v1 index.yml must contain a modes array");
  }

  return index.modes.map((entry, indexPosition) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`v1 index mode entry ${indexPosition} must be a mapping`);
    }
    return entry as V1IndexMode;
  });
}

function assertV1Index(index: V1Index): void {
  if (index.version !== 1) {
    throw new Error("v1 index.yml must declare version 1");
  }
}

function readModeId(entry: V1IndexMode, notices: MigrateNotice[]): string | undefined {
  if (typeof entry.id !== "string" || !MODE_ID_PATTERN.test(entry.id)) {
    notices.push({
      kind: "E_MODE_ID",
      detail: "index mode entry has a missing or invalid id and was skipped",
    });
    return undefined;
  }

  return entry.id;
}

async function resolveModePath(
  sourceRoot: string,
  entry: V1IndexMode,
  modeId: string,
  notices: MigrateNotice[],
): Promise<string | undefined> {
  const declared = typeof entry.file === "string" ? entry.file : `modes/${modeId}.yml`;
  const modesRoot = resolve(sourceRoot, "modes");
  const candidate = resolve(sourceRoot, declared);

  if (!isWithin(candidate, modesRoot)) {
    notices.push({
      kind: "mode-path-invalid",
      modeId,
      detail: "declared mode file resolves outside the v1 modes directory and was skipped",
    });
    return undefined;
  }

  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile()) {
      notices.push({
        kind: "mode-path-invalid",
        modeId,
        detail: "declared mode path is not a regular file and was skipped",
      });
      return undefined;
    }

    const [realModesRoot, realCandidate] = await Promise.all([
      realpath(modesRoot),
      realpath(candidate),
    ]);
    if (!isWithin(realModesRoot, sourceRoot) || !isWithin(realCandidate, realModesRoot)) {
      notices.push({
        kind: "mode-path-invalid",
        modeId,
        detail: "declared mode file resolves outside the v1 modes directory and was skipped",
      });
      return undefined;
    }
    return realCandidate;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      notices.push({
        kind: "mode-path-invalid",
        modeId,
        detail: "declared mode file does not exist and was skipped",
      });
      return undefined;
    }
    throw error;
  }
}

async function convertMode(
  v1Mode: Record<string, unknown>,
  modeId: string,
  sourceRoot: string,
  copiedCatalogPaths: Set<string>,
  notices: MigrateNotice[],
): Promise<Record<string, unknown>> {
  if (typeof v1Mode.id === "string" && v1Mode.id !== modeId) {
    notices.push({
      kind: "mode-id-mismatch",
      modeId,
      detail: "mode file id differs from its index id; the index id was used for the v2 filename",
    });
  }

  const sections: V2Section[] = [];
  if (typeof v1Mode.description === "string") {
    sections.push({ id: "description", text: v1Mode.description });
  } else if (v1Mode.description !== undefined) {
    reportInvalidFieldType("description", "a string", modeId, notices);
  }

  convertVoice(v1Mode.voice, modeId, sections, notices);
  addModeStructuredSection(sections, "addressing", v1Mode.addressing, modeId, notices);
  convertCharacter(v1Mode.character, modeId, sections, notices);
  addModeStructuredSection(sections, "visual", v1Mode.visual, modeId, notices);

  if (v1Mode.meta !== undefined) {
    notices.push({
      kind: "unsupported-mode-field",
      modeId,
      detail: "top-level field 'meta' has no v2 envelope equivalent and was skipped",
    });
  }

  reportUnknownModeFields(v1Mode, modeId, notices);

  const catalogRefs = await convertCatalogRefs(
    v1Mode.vocabulary,
    modeId,
    sourceRoot,
    copiedCatalogPaths,
    notices,
  );
  const converted: Record<string, unknown> = {};

  if (typeof v1Mode.label === "string") {
    converted.voice_hint = v1Mode.label;
  } else if (v1Mode.label !== undefined) {
    reportInvalidFieldType("label", "a string", modeId, notices);
  }
  converted.sections = sections;
  if (catalogRefs.length > 0) {
    converted.catalog_refs = catalogRefs;
  }

  return converted;
}

function convertVoice(
  value: unknown,
  modeId: string,
  sections: V2Section[],
  notices: MigrateNotice[],
): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainRecord(value)) {
    reportInvalidFieldType("voice", "a mapping", modeId, notices);
    return;
  }

  const { mode, ...voicePayload } = value;
  if (mode === "inherit") {
    notices.push({
      kind: "inherit-base-unmapped",
      modeId,
      detail: "v1 voice.mode 'inherit' targets an external base persona, so no v2 extends field was emitted",
    });
  } else if (mode !== undefined && mode !== "override") {
    notices.push({
      kind: "unsupported-voice-mode",
      modeId,
      detail: "voice.mode is neither 'inherit' nor 'override'; it was omitted from the migrated payload",
    });
  }

  addStructuredSection(sections, "voice", voicePayload);
}

function convertCharacter(
  value: unknown,
  modeId: string,
  sections: V2Section[],
  notices: MigrateNotice[],
): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainRecord(value)) {
    reportInvalidFieldType("character", "a mapping", modeId, notices);
    return;
  }

  const { personality_notes: personalityNotes, ...structuredCharacter } = value;
  if (typeof personalityNotes === "string") {
    sections.push({
      id: "character-personality-notes",
      text: personalityNotes,
    });
  } else if (personalityNotes !== undefined) {
    reportInvalidFieldType(
      "character.personality_notes",
      "a string",
      modeId,
      notices,
    );
  }
  addStructuredSection(sections, "character", structuredCharacter);
}

function addModeStructuredSection(
  sections: V2Section[],
  id: string,
  value: unknown,
  modeId: string,
  notices: MigrateNotice[],
): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainRecord(value)) {
    reportInvalidFieldType(id, "a mapping", modeId, notices);
    return;
  }
  addStructuredSection(sections, id, value);
}

function addStructuredSection(sections: V2Section[], id: string, value: unknown): void {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    return;
  }

  sections.push({
    id,
    text: stableYaml(value),
  });
}

function stableYaml(value: unknown): string {
  return YAML.stringify(value, {
    lineWidth: 0,
    sortMapEntries: true,
  });
}

async function convertCatalogRefs(
  vocabulary: unknown,
  modeId: string,
  sourceRoot: string,
  copiedCatalogPaths: Set<string>,
  notices: MigrateNotice[],
): Promise<V2CatalogRef[]> {
  if (vocabulary === undefined) {
    return [];
  }
  if (!isPlainRecord(vocabulary)) {
    reportInvalidFieldType("vocabulary", "a mapping", modeId, notices);
    return [];
  }

  for (const key of Object.keys(vocabulary).filter((key) => key !== "catalog_refs").sort()) {
    notices.push({
      kind: "unsupported-vocabulary-field",
      modeId,
      detail: `vocabulary field '${key}' is not supported by the v2 catalog reference model and was skipped`,
    });
  }

  if (vocabulary.catalog_refs === undefined) {
    return [];
  }
  if (!Array.isArray(vocabulary.catalog_refs)) {
    reportInvalidFieldType("vocabulary.catalog_refs", "an array", modeId, notices);
    return [];
  }

  const converted: V2CatalogRef[] = [];
  const seenPaths = new Set<string>();

  for (const [referenceIndex, rawReference] of vocabulary.catalog_refs.entries()) {
    if (isPlainRecord(rawReference)) {
      for (const key of Object.keys(rawReference)
        .filter((key) => key !== "catalog" && key !== "sections")
        .sort()) {
        notices.push({
          kind: "unsupported-catalog-ref-field",
          modeId,
          detail: `vocabulary.catalog_refs[${referenceIndex}] field '${key}' is unsupported and was skipped`,
        });
      }
    }

    if (!isPlainRecord(rawReference) || typeof rawReference.catalog !== "string") {
      notices.push({
        kind: "E_CATALOG_REF",
        modeId,
        detail: "catalog reference has no string 'catalog' key and was skipped",
      });
      continue;
    }

    const resolution = resolveCatalogPath(
      sourceRoot,
      rawReference.catalog,
      copiedCatalogPaths,
    );
    if (resolution.path === undefined) {
      notices.push({
        kind: "E_CATALOG_REF",
        modeId,
        detail: resolution.warning ?? "catalog reference could not be resolved and was skipped",
      });
      continue;
    }

    if (rawReference.sections !== undefined) {
      notices.push({
        kind: "catalog-sections-unsupported",
        modeId,
        detail: "v1 catalog section filtering has no v2 equivalent and was skipped; any emitted reference includes the file in full",
      });
    }

    if (seenPaths.has(resolution.path)) {
      notices.push({
        kind: "duplicate-catalog-ref",
        modeId,
        detail: "duplicate reference to the same catalog file was skipped",
      });
      continue;
    }

    const catalogBytes = await readFile(join(sourceRoot, "catalogs", resolution.path));
    try {
      decodeUtf8Strict(catalogBytes);
    } catch {
      notices.push({
        kind: "catalog-ref-invalid-utf8",
        modeId,
        detail: `referenced catalog file '${resolution.path}' is not valid UTF-8 and cannot be a catalog_refs target under SPEC §2.2; the reference was skipped but the file was still copied`,
      });
      continue;
    }

    seenPaths.add(resolution.path);
    converted.push({
      path: `catalogs/${resolution.path}`,
      id: toCatalogSectionId(converted.length + 1),
      priority: (converted.length + 1) * 10,
    });
  }

  return converted;
}

function reportInvalidFieldType(
  field: string,
  expectedType: string,
  modeId: string,
  notices: MigrateNotice[],
): void {
  notices.push({
    kind: "invalid-field-type",
    modeId,
    detail: `field '${field}' must be ${expectedType}; its value was skipped`,
  });
}

function resolveCatalogPath(
  sourceRoot: string,
  declaredPath: string,
  copiedCatalogPaths: Set<string>,
): CatalogResolution {
  if (isAbsolute(declaredPath)) {
    return { warning: "absolute catalog path is not allowed and was skipped" };
  }

  const catalogsRoot = resolve(sourceRoot, "catalogs");
  const unresolved = resolve(catalogsRoot, declaredPath);
  if (!isWithin(unresolved, catalogsRoot)) {
    return { warning: "catalog path resolves outside the v1 catalogs directory and was skipped" };
  }

  const relativePath = relative(catalogsRoot, unresolved).split(sep).join("/");
  const candidates = extname(relativePath) === ""
    ? [relativePath, `${relativePath}.yml`, `${relativePath}.yaml`]
    : [relativePath];
  const matches = candidates.filter((candidate) => copiedCatalogPaths.has(candidate));

  if (matches.length === 0) {
    return { warning: "catalog path does not resolve to a regular file and was skipped" };
  }
  if (matches.length > 1) {
    return { warning: "extensionless catalog path is ambiguous and was skipped" };
  }

  return { path: matches[0] };
}

function toCatalogSectionId(position: number): string {
  return `catalog-${position}`;
}

function migrateExplicitAliases(
  entry: V1IndexMode,
  modeId: string,
  candidates: AliasCandidate[],
  notices: MigrateNotice[],
): void {
  const explicit = entry.triggers?.explicit;
  if (explicit === undefined) {
    return;
  }
  if (!Array.isArray(explicit)) {
    notices.push({
      kind: "invalid-explicit-triggers",
      modeId,
      detail: "triggers.explicit is not an array and was skipped",
    });
    return;
  }

  for (const alias of explicit) {
    if (typeof alias !== "string") {
      notices.push({
        kind: "invalid-explicit-trigger",
        modeId,
        detail: "non-string triggers.explicit entry was skipped",
      });
      continue;
    }

    const normalized = normalizeAlias(alias);
    if (normalized.length === 0) {
      notices.push({
        kind: "invalid-explicit-trigger",
        modeId,
        detail: "explicit trigger normalizes to an empty utterance and was skipped",
      });
      continue;
    }
    if (normalized.startsWith("/persona")) {
      notices.push({
        kind: "E_ALIAS_RESERVED",
        modeId,
        detail: "normalized alias starts with the reserved '/persona' command and was skipped",
      });
      continue;
    }

    candidates.push({ modeId, normalized, value: alias });
  }
}

/**
 * SPEC §2.4 normalization v1 (NFKC → trim/collapse whitespace → ASCII-only
 * lowercase), implemented locally for migrate's collision detection. This duplicates
 * the #19 compile-side logic and is expected to be unified under #21.
 * Do not let either copy drift from the SPEC §2.4 algorithm.
 */
export function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(WHITESPACE_PATTERN, " ")
    .replace(ASCII_UPPERCASE_PATTERN, (character) => character.toLowerCase());
}

function finalizeAliases(
  candidates: AliasCandidate[],
  knownModeIds: Set<string>,
  notices: MigrateNotice[],
): Record<string, string[]> {
  const aliases = new Map<string, string[]>();
  const groups = new Map<string, AliasCandidate[]>();

  for (const candidate of candidates) {
    if (knownModeIds.has(candidate.modeId)) {
      const group = groups.get(candidate.normalized) ?? [];
      group.push(candidate);
      groups.set(candidate.normalized, group);
      continue;
    }

    notices.push({
      kind: "E_ALIAS_UNKNOWN_MODE",
      modeId: candidate.modeId,
      detail: "alias targets a mode that was not migrated and was skipped",
    });
  }

  for (const group of groups.values()) {
    if (group.length > 1) {
      const modeIds = [...new Set(group.map(({ modeId }) => modeId))].sort();
      for (const candidate of group) {
        notices.push({
          kind: "E_ALIAS_COLLISION",
          modeId: candidate.modeId,
          detail: `normalized alias is in a ${group.length}-entry collision class across modes '${modeIds.join("', '")}'; all members were skipped`,
        });
      }
      continue;
    }

    const [candidate] = group;
    if (candidate !== undefined) {
      const values = aliases.get(candidate.modeId) ?? [];
      values.push(candidate.value);
      aliases.set(candidate.modeId, values);
    }
  }

  return Object.fromEntries(aliases);
}

function reportUnsupportedAutoTriggers(
  entry: V1IndexMode,
  modeId: string,
  notices: MigrateNotice[],
): void {
  const auto = entry.triggers?.auto;
  if (!isPlainRecord(auto)) {
    if (auto !== undefined) {
      notices.push({
        kind: "unsupported-auto-trigger",
        modeId,
        detail: "triggers.auto is not a mapping and was skipped because v2 aliases require full-utterance matching",
      });
    }
    return;
  }

  for (const category of Object.keys(auto).sort()) {
    notices.push({
      kind: "unsupported-auto-trigger",
      modeId,
      detail: `auto trigger category '${category}' is unsupported under the full-match alias model and was skipped`,
    });
  }
}

function reportPriority(
  entry: V1IndexMode,
  modeId: string,
  notices: MigrateNotice[],
): void {
  if (entry.priority !== undefined) {
    notices.push({
      kind: "unsupported-index-field",
      modeId,
      detail: "index field 'priority' has no v2 pack equivalent and was skipped",
    });
  }
}

function reportIndexDefaults(index: V1Index, notices: MigrateNotice[]): void {
  if (index.default_mode !== undefined && index.default_mode !== "public") {
    notices.push({
      kind: "unsupported-default-mode",
      detail: "non-public index default_mode has no v2 pack equivalent and was skipped",
    });
  }
}

function reportUnknownModeFields(
  v1Mode: Record<string, unknown>,
  modeId: string,
  notices: MigrateNotice[],
): void {
  const supported = new Set([
    "id",
    "label",
    "description",
    "voice",
    "vocabulary",
    "addressing",
    "character",
    "visual",
    "meta",
  ]);

  for (const key of Object.keys(v1Mode).filter((key) => !supported.has(key)).sort()) {
    notices.push({
      kind: "unsupported-mode-field",
      modeId,
      detail: `top-level field '${key}' is not defined by the documented v1 schema and was skipped`,
    });
  }
}

async function copyCatalogTree(
  sourceRoot: string,
  destinationRoot: string,
  notices: MigrateNotice[],
): Promise<CatalogCopyResult> {
  const stats: CatalogCopyResult = {
    filesCopied: 0,
    bytesCopied: 0,
    copiedPaths: new Set(),
  };

  try {
    const metadata = await lstat(sourceRoot);
    if (!metadata.isDirectory()) {
      notices.push({
        kind: "catalogs-not-directory",
        detail: "v1 catalogs path is not a directory and was skipped",
      });
      return stats;
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      notices.push({
        kind: "catalogs-missing",
        detail: "v1 catalogs directory is absent; an empty v2 catalogs directory was emitted",
      });
      await mkdir(destinationRoot, { recursive: true });
      return stats;
    }
    throw error;
  }

  await copyDirectory(sourceRoot, destinationRoot, "", stats, notices);
  return stats;
}

async function copyDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory: string,
  stats: CatalogCopyResult,
  notices: MigrateNotice[],
): Promise<void> {
  await mkdir(destinationDirectory, { recursive: true });
  const entries = await readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    const relativePath = join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, relativePath, stats, notices);
      continue;
    }
    if (entry.isFile()) {
      const metadata = await stat(sourcePath);
      await copyFile(sourcePath, destinationPath);
      stats.filesCopied += 1;
      stats.bytesCopied += metadata.size;
      stats.copiedPaths.add(relativePath.split(sep).join("/"));
      continue;
    }

    notices.push({
      kind: "unsupported-catalog-entry",
      detail: `catalog entry '${entry.name}' is not a regular file or directory and was skipped`,
    });
  }
}

async function writeYamlFile(path: string, value: unknown): Promise<void> {
  const output = YAML.stringify(value, { lineWidth: 0 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output, "utf8");
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
