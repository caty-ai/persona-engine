import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PolicyJson } from "@persona-engine/core";

export const PRIVATE_BLOCK = "<persona-mode id=\"test-mode-a\" pack=\"test-pack@1.0.0\">\nDummy test guidance.\n</persona-mode>";

export function writeBuild(
  root: string,
  policy: PolicyJson = {
    routes: [{
      id: "voice-private",
      match: { session_key_rest: { prefix: "voice-" } },
      allowed_modes: ["public", "test-mode-a"],
      switching: "explicit-and-agent",
      state_domain: "private",
      owner_verified: true,
    }],
    domains: ["private", "quarantine"],
    modes: ["public", "test-mode-a"],
    default_route: { state_domain: "quarantine" },
    audit_dir: "audit/",
  },
): void {
  const build = join(root, "build");
  mkdirSync(join(build, "modes"), { recursive: true });
  const bytes = Buffer.from(PRIVATE_BLOCK);
  writeFileSync(join(build, "modes", "test-mode-a.md"), bytes);
  writeFileSync(join(build, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(build, "triggers.json"), JSON.stringify({
    normalization: 1,
    reserved_prefix: "/persona",
    aliases: { "/persona test-mode-a": "test-mode-a" },
  }));
  writeFileSync(join(build, "manifest.json"), JSON.stringify({
    schema_version: 2,
    pack_name: "test-pack",
    pack_version: "1.0.0",
    engine_version: "0.0.0",
    engine_range: { min: "0.0.0", max: null },
    built_at: "2026-01-01T00:00:00.000Z",
    content_hash: "0".repeat(64),
    counter: "pe-count-v1",
    modes: {
      "test-mode-a": {
        bytes: bytes.byteLength,
        tokens: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  }));
}
