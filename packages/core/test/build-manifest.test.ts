import { describe, expect, it } from "vitest";

import { engineCompatible, isBuildManifest } from "../src/build-manifest.js";

const manifest = {
  schema_version: 2,
  pack_name: "dummy-pack",
  pack_version: "1.2.3-alpha.1+build.5",
  engine_version: "1.2.9",
  engine_range: { min: "1.0.0", max: null },
  built_at: "2026-01-01T00:00:00.000Z",
  content_hash: "0".repeat(64),
  counter: "pe-count-v1",
  modes: {},
};

describe("shared build manifest validation", () => {
  it("keeps strict major.minor engine compatibility with valid semver syntax", () => {
    expect(engineCompatible("1.2.3", "1.2.99-beta.1+build")).toBe(true);
    expect(engineCompatible("1.2.3", "1.3.0")).toBe(false);
    expect(engineCompatible("1.2.3", "2.2.3")).toBe(false);
    expect(engineCompatible("01.2.3", "1.2.3")).toBe(false);
    expect(engineCompatible("1.2", "1.2.3")).toBe(false);
    expect(engineCompatible("1.2.3-", "1.2.3")).toBe(false);
  });

  it("enforces the pack-name format shared by runtime and doctor", () => {
    expect(isBuildManifest(manifest)).toBe(true);
    expect(isBuildManifest({ ...manifest, pack_name: "Invalid_Pack" })).toBe(false);
  });

  it("requires a valid engine range", () => {
    const missingRange: Record<string, unknown> = { ...manifest };
    delete missingRange.engine_range;
    expect(isBuildManifest(missingRange)).toBe(false);
    expect(isBuildManifest({ ...manifest, engine_range: { min: "1.0", max: null } })).toBe(false);
    expect(isBuildManifest({ ...manifest, engine_range: { min: "1.0.0", max: "2.0" } })).toBe(false);
    expect(isBuildManifest({ ...manifest, engine_range: { min: "1.0.0", max: "2.0.0" } })).toBe(true);
  });

  it("rejects a missing engine range minimum", () => {
    expect(isBuildManifest({ ...manifest, engine_range: { max: null } })).toBe(false);
  });

  it("rejects a non-string engine range minimum", () => {
    expect(isBuildManifest({ ...manifest, engine_range: { min: 1, max: null } })).toBe(false);
  });

  it("rejects a non-null, non-string engine range maximum", () => {
    expect(isBuildManifest({ ...manifest, engine_range: { min: "1.0.0", max: true } })).toBe(false);
  });
});
