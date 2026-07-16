import type { BuildManifest } from "./types.js";
import { isRecord } from "./json.js";

const BUILD_SCHEMA_VERSION = 2;
const MODE_ID = /^[a-z0-9-]+$/u;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseVersionCore(value: string): readonly [number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\./u.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/** SPEC §12: build and runtime engines must match exactly at major.minor. */
export function engineCompatible(built: string, running: string): boolean {
  if (!SEMVER.test(built) || !SEMVER.test(running)) return false;
  const builtCore = parseVersionCore(built);
  const runningCore = parseVersionCore(running);
  return builtCore !== undefined &&
    runningCore !== undefined &&
    builtCore[0] === runningCore[0] &&
    builtCore[1] === runningCore[1];
}

export function isBuildManifest(value: unknown): value is BuildManifest {
  if (!isRecord(value) ||
      value.schema_version !== BUILD_SCHEMA_VERSION ||
      typeof value.pack_name !== "string" ||
      !MODE_ID.test(value.pack_name) ||
      typeof value.pack_version !== "string" ||
      !SEMVER.test(value.pack_version) ||
      typeof value.engine_version !== "string" ||
      !SEMVER.test(value.engine_version) ||
      !isRecord(value.engine_range) ||
      typeof value.engine_range.min !== "string" ||
      !SEMVER.test(value.engine_range.min) ||
      !(value.engine_range.max === null ||
        (typeof value.engine_range.max === "string" && SEMVER.test(value.engine_range.max))) ||
      typeof value.built_at !== "string" ||
      !Number.isFinite(Date.parse(value.built_at)) ||
      value.counter !== "pe-count-v1" ||
      typeof value.content_hash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.content_hash) ||
      !isRecord(value.modes)) {
    return false;
  }

  return Object.entries(value.modes).every(([id, metadata]) =>
    MODE_ID.test(id) &&
    isRecord(metadata) &&
    Number.isSafeInteger(metadata.bytes) &&
    (metadata.bytes as number) >= 0 &&
    Number.isSafeInteger(metadata.tokens) &&
    (metadata.tokens as number) >= 0 &&
    typeof metadata.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(metadata.sha256) &&
    (metadata.voice_hint === undefined || typeof metadata.voice_hint === "string"),
  );
}
