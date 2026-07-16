import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type { BuildError, BuildErrorCode } from "../errors.js";
import { isRecord, type JsonRecord } from "../json.js";
import type {
  BuildManifest,
  MatchSpec,
  PolicyJson,
  RouteDecl,
  TriggersJson,
} from "../types.js";
import { countPeTokens, effectiveBudget } from "./budget.js";
import { contentHash, sha256, type RawPackFile } from "./hash.js";
import {
  deepMerge,
  duplicateIds,
  mergeIdList,
  type IdItem,
} from "./merge.js";
import { normalizeV1 } from "../normalize.js";
import {
  isMatchSpec,
  routesOverlap,
  RUNTIME_MATCH_KEYS,
} from "./routes.js";
import { parseSafeYaml } from "./yaml.js";

type SectionItem = IdItem & { text?: string };
type CatalogItem = IdItem & { path?: string; priority?: number };

type RawMode = {
  id: string;
  path: string;
  extends?: string;
  data: JsonRecord;
  sections: SectionItem[];
  catalogRefs: CatalogItem[];
  locallyValid: boolean;
};

type ResolvedMode = {
  id: string;
  data: JsonRecord;
  sections: SectionItem[];
  catalogRefs: CatalogItem[];
};

type ManifestInput = {
  schema_version: 2;
  pack_version: string;
  name: string;
  engine_min: string;
  engine_max?: string;
  default_budget_tokens?: number;
};

type InstallInput = {
  schema_version: 2;
  pack: string;
  placeholders: Record<string, string>;
  budget_tokens?: number;
  runtime: string;
  routes: unknown[];
  default_route?: unknown;
  audit?: unknown;
};

export type CompilePackOptions = {
  packDir: string;
  installFile?: string;
  engineVersion: string;
  /** Injectable solely for deterministic manifests in tests. */
  builtAt?: string | Date;
};

export type CompileArtifacts = {
  manifest: BuildManifest;
  modes: Record<string, string>;
  triggers: TriggersJson;
  policy: PolicyJson;
  /** Exact UTF-8 artifact bodies keyed by build-relative path. */
  files: Record<string, string>;
};

export type CompileResult =
  | { ok: true; artifacts: CompileArtifacts }
  | { ok: false; errors: BuildError[] };

export type BuildPackOptions = CompilePackOptions & { outputDir?: string };
export type BuildResult = CompileResult & { outputDir?: string };

function validPositiveBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

// Interim Issue #43 behavior: compare only the numeric core, not full SemVer
// prerelease/build-metadata precedence (for example, 1.0.0-alpha vs 1.0.0).
function compareSemverCore(left: string, right: string): number {
  const numericCore = (value: string): readonly [bigint, bigint, bigint] => {
    const match = SEMVER.exec(value);
    if (match === null) throw new TypeError(`Invalid semantic version '${value}'`);
    return [BigInt(match[1] ?? "0"), BigInt(match[2] ?? "0"), BigInt(match[3] ?? "0")];
  };
  const leftCore = numericCore(left);
  const rightCore = numericCore(right);
  for (let index = 0; index < leftCore.length; index += 1) {
    const leftPart = leftCore[index] ?? 0n;
    const rightPart = rightCore[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function errorSort(left: BuildError, right: BuildError): number {
  return (left.path ?? "").localeCompare(right.path ?? "")
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message);
}

class ErrorCollector {
  readonly errors: BuildError[] = [];
  readonly #keys = new Set<string>();

  add(code: BuildErrorCode, message: string, path?: string): void {
    const key = `${code}\0${path ?? ""}\0${message}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.errors.push({ code, message, ...(path === undefined ? {} : { path }) });
  }

  result(): BuildError[] {
    return [...this.errors].sort(errorSort);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function readYaml(path: string): unknown {
  const bytes = readFileSync(path);
  return parseSafeYaml(decodeUtf8(bytes, path));
}

function discoverFiles(root: string, relativeRoot = ""): RawPackFile[] {
  const absolute = resolve(root, relativeRoot);
  if (!existsSync(absolute)) return [];
  const entries = readdirSync(absolute, { withFileTypes: true })
    .sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const files: RawPackFile[] = [];
  for (const entry of entries) {
    const rel = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    const full = resolve(root, ...rel.split("/"));
    if (entry.isDirectory()) files.push(...discoverFiles(root, rel));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push({ path: rel, bytes: readFileSync(full) });
  }
  return files;
}

function packInputFiles(packDir: string): RawPackFile[] {
  const files: RawPackFile[] = [];
  for (const fixed of ["manifest.yml", "aliases.yml"]) {
    const full = resolve(packDir, fixed);
    if (existsSync(full)) files.push({ path: fixed, bytes: readFileSync(full) });
  }
  files.push(...discoverFiles(packDir, "modes"));
  files.push(...discoverFiles(packDir, "catalogs"));
  return files;
}

function parseManifest(packDir: string, errors: ErrorCollector): ManifestInput | undefined {
  const path = resolve(packDir, "manifest.yml");
  let value: unknown;
  try {
    value = readYaml(path);
  } catch (error) {
    errors.add("E_PARSE", `manifest.yml is invalid: ${error instanceof Error ? error.message : String(error)}`, "manifest.yml");
    return undefined;
  }
  if (!isRecord(value)) {
    errors.add("E_PARSE", "manifest.yml top-level must be a map", "manifest.yml");
    return undefined;
  }
  if (value.schema_version !== 2) {
    const newer = typeof value.schema_version === "number" && value.schema_version > 2;
    const receivedVersion = value.schema_version;
    errors.add(
      "E_SCHEMA_VERSION",
      newer ? `Unsupported schema_version ${String(receivedVersion)}; update the engine` : "manifest.yml must declare schema_version: 2",
      "manifest.yml",
    );
    return undefined;
  }
  const engine = value.engine;
  const valid = typeof value.pack_version === "string"
    && SEMVER.test(value.pack_version)
    && typeof value.name === "string"
    && /^[a-z0-9-]+$/u.test(value.name)
    && isRecord(engine)
    && typeof engine.min === "string"
    && SEMVER.test(engine.min)
    && (engine.max === undefined || engine.max === null || (typeof engine.max === "string" && SEMVER.test(engine.max)))
    && (value.default_budget_tokens === undefined || validPositiveBudget(value.default_budget_tokens));
  if (!valid) {
    errors.add("E_SCHEMA_VERSION", "manifest.yml does not match the v2 manifest schema", "manifest.yml");
    return undefined;
  }
  const engineMin = (engine as JsonRecord).min as string;
  const engineMax = (engine as JsonRecord).max;
  if (typeof engineMax === "string" && compareSemverCore(engineMin, engineMax) > 0) {
    errors.add("E_SCHEMA_VERSION", "manifest.yml declares an inverted engine range (min > max)", "manifest.yml");
    return undefined;
  }
  return {
    schema_version: 2,
    pack_version: value.pack_version as string,
    name: value.name as string,
    engine_min: engineMin,
    ...(engineMax === undefined || engineMax === null
      ? {}
      : { engine_max: engineMax as string }),
    ...(value.default_budget_tokens === undefined ? {} : { default_budget_tokens: value.default_budget_tokens as number }),
  };
}

function modeFiles(packDir: string): string[] {
  const modesDir = resolve(packDir, "modes");
  if (!existsSync(modesDir)) return [];
  return readdirSync(modesDir, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function parseIdItems(
  value: unknown,
  kind: "sections" | "catalog_refs",
  modePath: string,
  errors: ErrorCollector,
): { items: IdItem[]; valid: boolean } {
  if (value === undefined) return { items: [], valid: true };
  if (!Array.isArray(value)) {
    errors.add(kind === "sections" ? "E_SECTION_CONFLICT" : "E_CATALOG_REF", `${kind} must be a list`, modePath);
    return { items: [], valid: false };
  }
  const items: IdItem[] = [];
  let valid = true;
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !/^[a-z0-9_-]+$/u.test(raw.id)) {
      errors.add(kind === "sections" ? "E_SECTION_CONFLICT" : "E_CATALOG_REF", `${kind} entries require a valid id`, modePath);
      valid = false;
      continue;
    }
    const item = { ...raw, id: raw.id } as IdItem;
    if (raw.remove !== undefined && raw.remove !== true) {
      errors.add("E_SECTION_CONFLICT", `${kind} '${raw.id}' has an invalid remove flag`, modePath);
      valid = false;
    }
    if (kind === "sections") {
      if (raw.remove === true && Object.hasOwn(raw, "text")) {
        errors.add("E_SECTION_CONFLICT", `section '${raw.id}' cannot specify remove and text`, modePath);
        valid = false;
      } else if (raw.remove !== true && typeof raw.text !== "string") {
        errors.add("E_SECTION_CONFLICT", `section '${raw.id}' requires text`, modePath);
        valid = false;
      }
    } else if (raw.remove === true) {
      if (Object.hasOwn(raw, "path") || Object.hasOwn(raw, "priority")) {
        // catalog_refs inherits the same id-list removal semantics as sections.
        errors.add("E_SECTION_CONFLICT", `catalog_ref '${raw.id}' cannot specify remove with path or priority`, modePath);
        valid = false;
      }
    } else if (typeof raw.path !== "string" || typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
      errors.add("E_CATALOG_REF", `catalog_ref '${raw.id}' requires a path and numeric priority`, modePath);
      valid = false;
    }
    items.push(item);
  }
  return { items, valid };
}

function parseModes(packDir: string, errors: ErrorCollector): Map<string, RawMode> {
  const modes = new Map<string, RawMode>();
  const files = modeFiles(packDir);
  const filesById = new Map<string, string[]>();
  for (const file of files) {
    const id = file.replace(/\.ya?ml$/u, "");
    const matchingFiles = filesById.get(id) ?? [];
    matchingFiles.push(file);
    filesById.set(id, matchingFiles);
  }
  const collidingIds = new Set<string>();
  for (const [id, matchingFiles] of filesById) {
    if (matchingFiles.length < 2) continue;
    collidingIds.add(id);
    errors.add(
      "E_MODE_ID",
      `Mode id '${id}' is defined by multiple files: ${matchingFiles.join(", ")}`,
      `modes/${matchingFiles[0]}`,
    );
  }

  for (const file of files) {
    const id = file.replace(/\.ya?ml$/u, "");
    const modePath = `modes/${file}`;
    if (id === "public") errors.add("E_RESERVED_MODE", "public is an implicit reserved mode", modePath);
    if (!/^[a-z0-9-]+$/u.test(id)) errors.add("E_MODE_ID", `Invalid mode id '${id}'`, modePath);
    let value: unknown;
    try {
      value = readYaml(resolve(packDir, "modes", file));
    } catch (error) {
      errors.add("E_PARSE", `Mode YAML is invalid: ${error instanceof Error ? error.message : String(error)}`, modePath);
      continue;
    }
    if (!isRecord(value)) {
      errors.add("E_PARSE", "Mode YAML must be a map", modePath);
      continue;
    }
    let locallyValid = id !== "public" && /^[a-z0-9-]+$/u.test(id) && !collidingIds.has(id);
    if (value.extends !== undefined && typeof value.extends !== "string") {
      errors.add("E_EXTENDS_UNKNOWN", "extends must name one mode", modePath);
      locallyValid = false;
    }
    if (value.budget_tokens !== undefined && !validPositiveBudget(value.budget_tokens)) {
      errors.add("E_BUDGET_EXCEEDED", "budget_tokens must be a non-negative integer", modePath);
      locallyValid = false;
    }
    if (value.voice_hint !== undefined && typeof value.voice_hint !== "string") {
      errors.add("E_SECTION_CONFLICT", "voice_hint must be a string", modePath);
      locallyValid = false;
    }
    const sections = parseIdItems(value.sections, "sections", modePath, errors);
    const catalogRefs = parseIdItems(value.catalog_refs, "catalog_refs", modePath, errors);
    locallyValid = locallyValid && sections.valid && catalogRefs.valid;
    const combined = [...sections.items, ...catalogRefs.items];
    for (const duplicate of duplicateIds(combined)) {
      errors.add("E_SECTION_DUP", `Duplicate section id '${duplicate}' in one mode file`, modePath);
      locallyValid = false;
    }
    modes.set(id, {
      id,
      path: modePath,
      ...(typeof value.extends === "string" ? { extends: value.extends } : {}),
      data: { ...value },
      sections: sections.items as SectionItem[],
      catalogRefs: catalogRefs.items as CatalogItem[],
      locallyValid,
    });
  }
  return modes;
}

function resolveModes(modes: Map<string, RawMode>, errors: ErrorCollector): Map<string, ResolvedMode> {
  const graphInvalid = new Set<string>();
  for (const mode of modes.values()) {
    if (mode.extends !== undefined && !modes.has(mode.extends)) {
      errors.add("E_EXTENDS_UNKNOWN", `Mode '${mode.id}' extends unknown mode '${mode.extends}'`, mode.path);
      graphInvalid.add(mode.id);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start).concat(id);
      errors.add("E_EXTENDS_CYCLE", `Inheritance cycle: ${cycle.join(" -> ")}`, modes.get(id)?.path);
      for (const item of cycle) graphInvalid.add(item);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    const parent = modes.get(id)?.extends;
    if (parent !== undefined && modes.has(parent)) visit(parent);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of modes.keys()) visit(id);

  for (const mode of modes.values()) {
    let cursor: RawMode | undefined = mode;
    let edges = 0;
    const seen = new Set<string>();
    while (cursor?.extends !== undefined && modes.has(cursor.extends) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      edges += 1;
      cursor = modes.get(cursor.extends);
    }
    if (edges > 8) {
      errors.add("E_EXTENDS_DEPTH", `Mode '${mode.id}' has inheritance depth ${edges}; maximum is 8`, mode.path);
      graphInvalid.add(mode.id);
    }
  }

  const resolved = new Map<string, ResolvedMode>();
  const resolveOne = (id: string): ResolvedMode | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    const mode = modes.get(id);
    if (mode === undefined || !mode.locallyValid || graphInvalid.has(id)) return undefined;
    let parent: ResolvedMode | undefined;
    if (mode.extends !== undefined) {
      parent = resolveOne(mode.extends);
      if (parent === undefined) return undefined;
    }
    const baseData = parent?.data ?? {};
    const childData = { ...mode.data };
    delete childData.extends;
    delete childData.sections;
    delete childData.catalog_refs;
    const data = deepMerge(baseData, childData);
    const sectionMerge = mergeIdList(parent?.sections ?? [], mode.sections, ["text"]);
    const catalogMerge = mergeIdList(parent?.catalogRefs ?? [], mode.catalogRefs, ["path", "priority"]);
    for (const issue of [...sectionMerge.issues, ...catalogMerge.issues]) {
      errors.add(
        issue.kind === "conflict" ? "E_SECTION_CONFLICT" : "E_SECTION_UNKNOWN",
        issue.kind === "conflict"
          ? `Removal for '${issue.id}' conflicts with replacement content`
          : `Cannot remove unknown section '${issue.id}'`,
        mode.path,
      );
    }
    if (sectionMerge.issues.length > 0 || catalogMerge.issues.length > 0) return undefined;
    const allFinalIds = [...sectionMerge.items, ...catalogMerge.items];
    const duplicates = duplicateIds(allFinalIds);
    if (duplicates.length > 0) {
      for (const duplicate of duplicates) errors.add("E_SECTION_DUP", `Resolved section id '${duplicate}' is duplicated`, mode.path);
      return undefined;
    }
    const result: ResolvedMode = {
      id,
      data,
      sections: sectionMerge.items as SectionItem[],
      catalogRefs: catalogMerge.items as CatalogItem[],
    };
    resolved.set(id, result);
    return result;
  };
  for (const id of modes.keys()) resolveOne(id);
  return resolved;
}

function parseInstall(
  packDir: string,
  installFile: string | undefined,
  errors: ErrorCollector,
): { install: InstallInput; installRoot: string } | undefined {
  if (installFile === undefined) {
    return {
      install: { schema_version: 2, pack: ".", placeholders: {}, runtime: "generic", routes: [] },
      installRoot: packDir,
    };
  }
  const absolute = resolve(installFile);
  let value: unknown;
  try {
    value = readYaml(absolute);
  } catch (error) {
    errors.add("E_PARSE", `install.yml is invalid: ${error instanceof Error ? error.message : String(error)}`, absolute);
    return undefined;
  }
  if (!isRecord(value)) {
    errors.add("E_PARSE", "install.yml top-level must be a map", absolute);
    return undefined;
  }
  if (value.schema_version !== 2) {
    const newer = typeof value.schema_version === "number" && value.schema_version > 2;
    const receivedVersion = value.schema_version;
    errors.add("E_SCHEMA_VERSION", newer ? `Unsupported install schema_version ${String(receivedVersion)}; update the engine` : "install.yml must declare schema_version: 2", absolute);
    return undefined;
  }
  const placeholders: Record<string, string> = {};
  let valid = true;
  if (value.placeholders !== undefined) {
    if (!isRecord(value.placeholders)) valid = false;
    else {
      for (const [key, placeholder] of Object.entries(value.placeholders)) {
        if (placeholder === null || typeof placeholder === "object") valid = false;
        else placeholders[key] = String(placeholder);
      }
    }
  }
  if (value.budget_tokens !== undefined && !validPositiveBudget(value.budget_tokens)) valid = false;
  if (typeof value.pack !== "string" || value.pack.trim().length === 0) valid = false;
  if (typeof value.runtime !== "string") valid = false;
  if (value.routes !== undefined && !Array.isArray(value.routes)) valid = false;
  if (!valid) {
    errors.add("E_SCHEMA_VERSION", "install.yml does not match the v2 install schema", absolute);
  }
  return {
    install: {
      schema_version: 2,
      pack: typeof value.pack === "string" ? value.pack : "",
      placeholders,
      ...(validPositiveBudget(value.budget_tokens) ? { budget_tokens: value.budget_tokens } : {}),
      runtime: typeof value.runtime === "string" ? value.runtime : "",
      routes: Array.isArray(value.routes) ? value.routes : [],
      ...(value.default_route === undefined ? {} : { default_route: value.default_route }),
      ...(value.audit === undefined ? {} : { audit: value.audit }),
    },
    installRoot: dirname(absolute),
  };
}

function pathParts(value: string): string[] {
  return value.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
}

function isPortableAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateAuditDir(install: InstallInput, installRoot: string, errors: ErrorCollector): string {
  let value = "audit/";
  if (install.audit !== undefined) {
    if (!isRecord(install.audit) || typeof install.audit.dir !== "string") {
      errors.add("E_AUDIT_DIR", "audit.dir must be a string relative path");
      return value;
    }
    value = install.audit.dir;
  }
  const parts = pathParts(value);
  if (value.length === 0 || isPortableAbsolute(value) || parts.includes("..")) {
    errors.add("E_AUDIT_DIR", `audit.dir '${value}' must be install-relative without '..'`);
    return value;
  }
  try {
    const rootReal = realpathSync(installRoot);
    let currentReal = rootReal;
    let completed = true;
    for (const part of parts) {
      const candidate = resolve(currentReal, part);
      let entry;
      try {
        entry = lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          completed = false;
          break;
        }
        throw error;
      }
      if (entry.isSymbolicLink()) {
        let resolvedSymlink: string;
        try {
          resolvedSymlink = realpathSync(candidate);
        } catch {
          errors.add("E_AUDIT_DIR", `audit.dir '${value}' contains a dangling or unresolvable symlink`);
          completed = false;
          break;
        }
        if (!isContained(rootReal, resolvedSymlink)) {
          errors.add("E_AUDIT_DIR", `audit.dir '${value}' escapes the install root`);
          completed = false;
          break;
        }
        currentReal = resolvedSymlink;
      } else {
        currentReal = candidate;
      }
    }
    if (completed && !statSync(currentReal).isDirectory()) {
      errors.add("E_AUDIT_DIR", `audit.dir '${value}' is not a directory`);
    }
  } catch (error) {
    errors.add("E_AUDIT_DIR", `audit.dir '${value}' cannot be validated: ${error instanceof Error ? error.message : String(error)}`);
  }
  const normalized = parts.join("/");
  return value.endsWith("/") || value.endsWith("\\") ? `${normalized}/` : normalized;
}

function validateRoutes(
  install: InstallInput,
  modeIds: ReadonlySet<string>,
  auditDir: string,
  errors: ErrorCollector,
): PolicyJson {
  const allowedKeys = RUNTIME_MATCH_KEYS[install.runtime];
  if (allowedKeys === undefined) {
    errors.add("E_ROUTE_BAD_MATCH", `Unknown install runtime '${install.runtime}'`);
  }
  const routes: RouteDecl[] = [];
  const seenRouteIds = new Set<string>();
  for (const [index, raw] of install.routes.entries()) {
    const path = `install.yml#routes[${index}]`;
    if (!isRecord(raw) || typeof raw.id !== "string" || seenRouteIds.has(raw.id)) {
      errors.add("E_ROUTE_BAD_MATCH", "Each route requires a unique string id", path);
      continue;
    }
    seenRouteIds.add(raw.id);
    let idValid = true;
    if (raw.id.startsWith("__")) {
      idValid = false;
      errors.add("E_ROUTE_ID_INVALID", `Route id '${raw.id}' uses the reserved '__' namespace`, path);
    } else if (!/^[a-z0-9-]+$/u.test(raw.id)) {
      idValid = false;
      errors.add("E_ROUTE_ID_INVALID", `Route id '${raw.id}' must match [a-z0-9-]+`, path);
    }
    let matchValid = isRecord(raw.match) && allowedKeys !== undefined;
    const match: Record<string, MatchSpec> = {};
    if (isRecord(raw.match)) {
      for (const [key, value] of Object.entries(raw.match)) {
        if (allowedKeys === undefined || !allowedKeys.has(key) || !isMatchSpec(value)) {
          matchValid = false;
        } else {
          match[key] = value;
        }
      }
    }
    if (!matchValid) {
      errors.add("E_ROUTE_BAD_MATCH", `Route '${raw.id}' has invalid match keys or values for runtime '${install.runtime}'`, path);
    }
    const allowedModes: string[] = [];
    if (!Array.isArray(raw.allowed_modes) || raw.allowed_modes.some((mode) => typeof mode !== "string")) {
      errors.add("E_ROUTE_UNKNOWN_MODE", `Route '${raw.id}' allowed_modes must be a string list`, path);
    } else {
      for (const mode of raw.allowed_modes as string[]) {
        if (mode !== "public" && !modeIds.has(mode)) errors.add("E_ROUTE_UNKNOWN_MODE", `Route '${raw.id}' references unknown mode '${mode}'`, path);
        if (!allowedModes.includes(mode)) allowedModes.push(mode);
      }
    }
    if (!allowedModes.includes("public")) allowedModes.unshift("public");
    if (typeof raw.state_domain !== "string" || !/^[a-z0-9_-]{1,64}$/u.test(raw.state_domain)) {
      errors.add("E_ROUTE_BAD_DOMAIN", `Route '${raw.id}' has an invalid state_domain`, path);
    }
    const switchingValid = raw.switching === "deny" || raw.switching === "explicit" || raw.switching === "explicit-and-agent";
    if (!switchingValid) errors.add("E_ROUTE_BAD_MATCH", `Route '${raw.id}' has invalid switching`, path);
    if (raw.owner_verified !== undefined && typeof raw.owner_verified !== "boolean") {
      errors.add("E_ROUTE_BAD_MATCH", `Route '${raw.id}' has invalid owner_verified`, path);
    }
    if (switchingValid && raw.switching !== "deny" && raw.owner_verified !== true) {
      errors.add("E_ROUTE_SWITCHING_UNVERIFIED", `Route '${raw.id}' enables switching without owner_verified: true`, path);
    }
    if (idValid && matchValid && typeof raw.state_domain === "string" && /^[a-z0-9_-]{1,64}$/u.test(raw.state_domain) && switchingValid) {
      const switching = raw.switching as RouteDecl["switching"];
      routes.push({
        id: raw.id,
        match,
        allowed_modes: allowedModes,
        switching,
        state_domain: raw.state_domain,
        owner_verified: raw.owner_verified === true,
      });
    }
  }
  for (let left = 0; left < routes.length; left += 1) {
    for (let right = left + 1; right < routes.length; right += 1) {
      const a = routes[left];
      const b = routes[right];
      if (a !== undefined && b !== undefined && routesOverlap(a, b)) {
        errors.add("E_ROUTE_OVERLAP", `Routes '${a.id}' and '${b.id}' overlap`);
      }
    }
  }

  let defaultDomain = "quarantine";
  if (install.default_route !== undefined) {
    if (!isRecord(install.default_route)) {
      errors.add("E_DEFAULT_ROUTE", "default_route must be a map containing only state_domain");
    } else {
      const extra = Object.keys(install.default_route).filter((key) => key !== "state_domain");
      if (extra.length > 0) errors.add("E_DEFAULT_ROUTE", `default_route cannot configure ${extra.join(", ")}`);
      if (install.default_route.state_domain !== undefined) {
        if (typeof install.default_route.state_domain !== "string" || !/^[a-z0-9_-]{1,64}$/u.test(install.default_route.state_domain)) {
          errors.add("E_ROUTE_BAD_DOMAIN", "default_route has an invalid state_domain");
        } else {
          defaultDomain = install.default_route.state_domain;
        }
      }
    }
  }
  const domains = [...new Set([...routes.map((route) => route.state_domain), defaultDomain])].sort();
  return {
    routes,
    domains,
    modes: ["public", ...[...modeIds].sort()],
    default_route: { state_domain: defaultDomain },
    audit_dir: auditDir,
  };
}

function parseAliases(
  packDir: string,
  modeIds: ReadonlySet<string>,
  placeholders: Readonly<Record<string, string>>,
  errors: ErrorCollector,
): TriggersJson {
  const aliasesPath = resolve(packDir, "aliases.yml");
  const mappings = new Map<string, string>();
  if (existsSync(aliasesPath)) {
    let value: unknown;
    try {
      value = readYaml(aliasesPath);
    } catch (error) {
      errors.add("E_PARSE", `aliases.yml is invalid: ${error instanceof Error ? error.message : String(error)}`, "aliases.yml");
      value = undefined;
    }
    if (value === undefined) {
      // The parse failure was reported above.
    } else if (!isRecord(value)) {
      errors.add("E_PARSE", "aliases.yml top-level must be a map", "aliases.yml");
    } else if (!isRecord(value.aliases)) {
      errors.add("E_PARSE", "aliases.yml must contain an aliases map", "aliases.yml");
    } else {
      for (const [mode, rawAliases] of Object.entries(value.aliases)) {
        if (mode !== "public" && !modeIds.has(mode)) errors.add("E_ALIAS_UNKNOWN_MODE", `Aliases reference unknown mode '${mode}'`, "aliases.yml");
        if (!Array.isArray(rawAliases) || rawAliases.some((alias) => typeof alias !== "string")) {
          errors.add("E_PARSE", `Aliases for '${mode}' must be a string list`, "aliases.yml");
          continue;
        }
        for (const alias of rawAliases as string[]) {
          const source = `Alias '${alias}'`;
          const substituted = applyPlaceholders(alias, placeholders, source, errors, "aliases.yml");
          const normalized = normalizeV1(substituted);
          const reportedPlaceholders = unresolvedPlaceholderCounts(alias, placeholders, normalized);
          reportPlaceholderResidue(normalized, source, errors, "aliases.yml", reportedPlaceholders);
          if (normalized.length === 0) {
            errors.add("E_PARSE", `${source} must be non-empty after placeholder substitution and normalization`, "aliases.yml");
            continue;
          }
          if (normalized.startsWith("/persona")) errors.add("E_ALIAS_RESERVED", `Alias '${substituted}' uses the reserved /persona prefix`, "aliases.yml");
          const previous = mappings.get(normalized);
          if (previous !== undefined) errors.add("E_ALIAS_COLLISION", `Normalized alias '${normalized}' collides between '${previous}' and '${mode}'`, "aliases.yml");
          else mappings.set(normalized, mode);
        }
      }
    }
  }
  const aliases: Record<string, string> = {};
  for (const [alias, mode] of [...mappings].sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))) aliases[alias] = mode;
  return { normalization: 1, reserved_prefix: "/persona", aliases };
}

function resolveCatalog(
  packDir: string,
  item: CatalogItem,
  modeId: string,
  errors: ErrorCollector,
): string | undefined {
  const value = item.path;
  if (typeof value !== "string") return undefined;
  const parts = pathParts(value);
  if (isPortableAbsolute(value) || parts.includes("..") || parts[0] !== "catalogs") {
    errors.add("E_CATALOG_REF", `Mode '${modeId}' has unsafe catalog path '${value}'`);
    return undefined;
  }
  const target = resolve(packDir, ...parts);
  try {
    const packReal = realpathSync(packDir);
    const catalogReal = realpathSync(resolve(packDir, "catalogs"));
    const targetReal = realpathSync(target);
    if (!isContained(packReal, catalogReal) || !isContained(catalogReal, targetReal) || !statSync(targetReal).isFile()) {
      errors.add("E_CATALOG_REF", `Catalog path '${value}' escapes pack/catalogs or is not a file`);
      return undefined;
    }
    return decodeUtf8(readFileSync(targetReal), value);
  } catch (error) {
    errors.add("E_CATALOG_REF", `Catalog path '${value}' cannot be read safely: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function applyPlaceholders(
  value: string,
  placeholders: Readonly<Record<string, string>>,
  source: string,
  errors: ErrorCollector,
  path?: string,
): string {
  return value.replace(/\{\{([^{}]+)\}\}/gu, (whole, key: string) => {
    if (!Object.hasOwn(placeholders, key)) {
      errors.add("E_PLACEHOLDER_UNRESOLVED", `${source} has unresolved placeholder '{{${key}}}'`, path);
      return whole;
    }
    return placeholders[key] ?? "";
  });
}

function unresolvedPlaceholderCounts(
  value: string,
  placeholders: Readonly<Record<string, string>>,
  residueValue: string,
): Map<string, number> {
  const reported = new Map<string, number>();
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    const rawKey = match[1] ?? "";
    if (!Object.hasOwn(placeholders, rawKey)) {
      const normalizedKey = normalizeV1(rawKey);
      reported.set(normalizedKey, (reported.get(normalizedKey) ?? 0) + 1);
    }
  }

  const residue = new Map<string, number>();
  for (const match of residueValue.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    const key = normalizeV1(match[1] ?? "");
    residue.set(key, (residue.get(key) ?? 0) + 1);
  }
  for (const [key, count] of reported) {
    const retained = Math.min(count, residue.get(key) ?? 0);
    if (retained === 0) reported.delete(key);
    else reported.set(key, retained);
  }
  return reported;
}

function reportPlaceholderResidue(
  value: string,
  source: string,
  errors: ErrorCollector,
  path?: string,
  alreadyReported = new Map<string, number>(),
): void {
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    const key = match[1] ?? "";
    const normalizedKey = normalizeV1(key);
    const remaining = alreadyReported.get(normalizedKey) ?? 0;
    if (remaining > 0) {
      alreadyReported.set(normalizedKey, remaining - 1);
      continue;
    }
    errors.add(
      "E_PLACEHOLDER_UNRESOLVED",
      `${source} still contains unresolved placeholder syntax after substitution: '{{${key}}}'`,
      path,
    );
  }
}

function canonicalText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\r\n]+$/gu, ""))
    .join("\n")
    .trim();
}

function renderBlock(modeId: string, packName: string, packVersion: string, sections: readonly string[]): string {
  const body = sections.map(canonicalText).join("\n\n");
  return `<persona-mode id="${modeId}" pack="${packName}@${packVersion}">\n${body}\n</persona-mode>`;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function compilePack(options: CompilePackOptions): CompileResult {
  const packDir = resolve(options.packDir);
  const errors = new ErrorCollector();
  const manifestInput = parseManifest(packDir, errors);
  const modes = parseModes(packDir, errors);
  const resolvedModes = resolveModes(modes, errors);
  const modeIds = new Set([...modes.keys()].filter((id) => id !== "public" && /^[a-z0-9-]+$/u.test(id)));
  const installResult = parseInstall(packDir, options.installFile, errors);
  const triggers = parseAliases(packDir, modeIds, installResult?.install.placeholders ?? {}, errors);

  const engineVersionValid = SEMVER.test(options.engineVersion);
  if (!engineVersionValid) {
    errors.add("E_SCHEMA_VERSION", `engine version '${options.engineVersion}' is not valid semver`);
  } else if (manifestInput !== undefined) {
    const belowMinimum = compareSemverCore(options.engineVersion, manifestInput.engine_min) < 0;
    const aboveMaximum = manifestInput.engine_max !== undefined
      && compareSemverCore(options.engineVersion, manifestInput.engine_max) > 0;
    if (belowMinimum || aboveMaximum) {
      errors.add(
        "E_SCHEMA_VERSION",
        `engine version '${options.engineVersion}' is outside pack range [${manifestInput.engine_min}, ${manifestInput.engine_max ?? "*"}]`,
      );
    }
  }

  let policy: PolicyJson | undefined;
  if (installResult !== undefined) {
    const auditDir = validateAuditDir(installResult.install, installResult.installRoot, errors);
    policy = validateRoutes(installResult.install, modeIds, auditDir, errors);
  }

  const blocks: Record<string, string> = {};
  const manifestModes: BuildManifest["modes"] = {};
  if (manifestInput !== undefined && installResult !== undefined) {
    for (const id of [...resolvedModes.keys()].sort()) {
      const mode = resolvedModes.get(id);
      if (mode === undefined) continue;
      const sectionTexts = mode.sections.map((section) => section.text ?? "");
      const catalogs = [...mode.catalogRefs].sort((left, right) => {
        const priority = (left.priority ?? 0) - (right.priority ?? 0);
        return priority || Buffer.from(left.path ?? "").compare(Buffer.from(right.path ?? ""));
      });
      let catalogFailed = false;
      for (const catalog of catalogs) {
        const text = resolveCatalog(packDir, catalog, id, errors);
        if (text === undefined) catalogFailed = true;
        else sectionTexts.push(text);
      }
      if (catalogFailed) continue;
      const source = `Mode '${id}'`;
      const substituted = sectionTexts.map((text) => applyPlaceholders(text, installResult.install.placeholders, source, errors));
      for (const [index, text] of substituted.entries()) {
        const residueText = normalizeV1(text);
        const reportedPlaceholders = unresolvedPlaceholderCounts(
          sectionTexts[index] ?? "",
          installResult.install.placeholders,
          residueText,
        );
        reportPlaceholderResidue(residueText, source, errors, undefined, reportedPlaceholders);
      }
      const block = renderBlock(id, manifestInput.name, manifestInput.pack_version, substituted);
      const bytes = Buffer.byteLength(block, "utf8");
      const tokens = countPeTokens(block);
      const modeBudget = validPositiveBudget(mode.data.budget_tokens) ? mode.data.budget_tokens : undefined;
      const budget = effectiveBudget(installResult.install.budget_tokens, manifestInput.default_budget_tokens, modeBudget);
      if (tokens > budget) {
        errors.add("E_BUDGET_EXCEEDED", `Mode '${id}' uses ${tokens} tokens, exceeding budget ${budget}`, modes.get(id)?.path);
      }
      blocks[id] = block;
      manifestModes[id] = {
        bytes,
        tokens,
        sha256: sha256(block),
        ...(typeof mode.data.voice_hint === "string" ? { voice_hint: mode.data.voice_hint } : {}),
      };
    }
  }

  if (errors.errors.length > 0 || manifestInput === undefined || installResult === undefined || policy === undefined) {
    return { ok: false, errors: errors.result() };
  }
  const builtAt = options.builtAt instanceof Date
    ? options.builtAt.toISOString()
    : options.builtAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(builtAt))) {
    throw new TypeError("builtAt must be a valid ISO-compatible date");
  }
  const manifest: BuildManifest = {
    schema_version: 2,
    pack_name: manifestInput.name,
    pack_version: manifestInput.pack_version,
    engine_version: options.engineVersion,
    engine_range: { min: manifestInput.engine_min, max: manifestInput.engine_max ?? null },
    built_at: builtAt,
    content_hash: contentHash(packInputFiles(packDir)),
    counter: "pe-count-v1",
    modes: manifestModes,
  };
  const files: Record<string, string> = {
    "manifest.json": serializeJson(manifest),
    "triggers.json": serializeJson(triggers),
    "policy.json": serializeJson(policy),
  };
  for (const [id, block] of Object.entries(blocks)) files[`modes/${id}.md`] = block;
  return { ok: true, artifacts: { manifest, modes: blocks, triggers, policy, files } };
}

function atomicWriteBuild(outputDir: string, files: Readonly<Record<string, string>>): void {
  const parent = dirname(outputDir);
  mkdirSync(parent, { recursive: true });
  const nonce = `${process.pid}-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12)}`;
  const temporary = resolve(parent, `.${basename(outputDir)}.tmp-${nonce}`);
  const backup = resolve(parent, `.${basename(outputDir)}.old-${nonce}`);
  let movedPrevious = false;
  try {
    mkdirSync(temporary, { recursive: false });
    for (const [path, body] of Object.entries(files)) {
      const target = resolve(temporary, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, "utf8");
    }
    if (existsSync(outputDir)) {
      renameSync(outputDir, backup);
      movedPrevious = true;
    }
  } catch (error) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`persona build: failed to remove temporary build at ${temporary}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw error;
  }

  // Publishing is a two-step rename dance, not a single atomic swap. There is
  // a small crash window after the old build moves aside and before the new one
  // appears. SPEC §8 F3 makes that fail closed (no build means no injection), so
  // a pointer-file or symlink-swap design is unnecessary for this risk profile.
  try {
    renameSync(temporary, outputDir);
  } catch (publishError) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`persona build: failed to remove temporary build at ${temporary}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    if (movedPrevious && !existsSync(outputDir) && existsSync(backup)) {
      try {
        renameSync(backup, outputDir);
      } catch (restoreError) {
        console.warn(`persona build: failed to restore previous build from ${backup}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    throw publishError;
  }

  if (movedPrevious) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`persona build: failed to remove stale build backup at ${backup}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

export function buildPack(options: BuildPackOptions): BuildResult {
  const result = compilePack(options);
  if (!result.ok) return result;
  const installRoot = options.installFile === undefined ? resolve(options.packDir) : dirname(resolve(options.installFile));
  const outputDir = resolve(options.outputDir ?? resolve(installRoot, "build"));
  atomicWriteBuild(outputDir, result.artifacts.files);
  return { ...result, outputDir };
}
