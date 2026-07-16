import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseAgentSessionKey,
  routeContextFromHook,
  routeContextFromTool,
} from "../src/route-context.js";
import { loadBuild, resolveRouteContext } from "../src/route-resolution.js";
import { writeBuild } from "./helpers.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "persona-openclaw-unit-"));
  writeBuild(root);
  return root;
}

describe("OpenClaw route context", () => {
  it("parses only anchored agent session keys and preserves the rest", () => {
    expect(parseAgentSessionKey("agent:main:voice-owner:part")).toBe("voice-owner:part");
    expect(parseAgentSessionKey("Agent:Main:CRON:daily")).toBe("CRON:daily");
    for (const value of ["subagent:main:voice-owner", "cron:main:voice-owner", "explicit:voice-owner", "agent::voice-owner", "agent:main:"]) {
      expect(parseAgentSessionKey(value)).toBeUndefined();
    }
  });

  it("passes through a defined channel and fails closed on malformed keys", () => {
    expect(routeContextFromHook({ sessionKey: "agent:main:voice-owner", channelId: "voice" })).toEqual({
      session_key_rest: "voice-owner",
      channel_id: "voice",
    });
    expect(routeContextFromHook({ sessionKey: "explicit:voice-owner" })).toEqual({});
    expect(routeContextFromTool({ sessionKey: "agent:main:voice-owner", messageChannel: "voice" })).toEqual({
      session_key_rest: "voice-owner",
      channel_id: "voice",
    });
    expect(routeContextFromTool({ sessionKey: "agent:main:voice-owner", messageChannel: "" })).toEqual({
      session_key_rest: "voice-owner",
    });
  });

  it("quarantines reserved and empty session-key rest classes for hooks and tools", () => {
    for (const sessionKey of [
      "agent:main:subagent:worker",
      "agent:main:cron:daily",
      "agent:main:explicit:owner",
      "Agent:Main:SUBAGENT:worker",
      "Agent:Main:CRON:daily",
      "Agent:Main:EXPLICIT:owner",
      "agent:main:",
    ]) {
      expect(routeContextFromHook({ sessionKey, channelId: "voice" })).toEqual({});
      expect(routeContextFromTool({ sessionKey, messageChannel: "voice" })).toEqual({});
    }
  });
});

describe("compiled build route resolution", () => {
  it("loads verified artifacts and resolves exact/prefix matches", () => {
    const root = fixture();
    const loaded = loadBuild(root, "0.0.9");
    expect(loaded.reason).toBeNull();
    expect(resolveRouteContext({ session_key_rest: "voice-owner" }, root).route_id).toBe("voice-private");
    expect(resolveRouteContext({ session_key_rest: "other" }, root).route_id).toBe("__default__");
  });

  it("cannot override reserved rest quarantine with an operator route", () => {
    for (const sessionKey of [
      "agent:main:subagent:worker",
      "Agent:Main:CRON:daily",
      "agent:main:explicit:owner",
    ]) {
      const root = mkdtempSync(join(tmpdir(), "persona-openclaw-reserved-route-"));
      writeBuild(root, {
        routes: [{
          id: "reserved-private",
          match: { session_key_rest: { prefix: parseAgentSessionKey(sessionKey) as string } },
          allowed_modes: ["public", "test-mode-a"],
          switching: "deny",
          state_domain: "private",
        }],
        domains: ["private", "quarantine"],
        modes: ["public", "test-mode-a"],
        default_route: { state_domain: "quarantine" },
        audit_dir: "audit/",
      });

      const rawContext = { session_key_rest: parseAgentSessionKey(sessionKey) as string };
      expect(resolveRouteContext(rawContext, root).route_id).toBe("reserved-private");
      expect(resolveRouteContext(routeContextFromHook({ sessionKey }), root).route_id).toBe("__default__");
      expect(resolveRouteContext(routeContextFromTool({ sessionKey }), root).route_id).toBe("__default__");
    }
  });

  it("rejects modified mode bytes against the manifest", () => {
    const root = fixture();
    writeFileSync(join(root, "build", "modes", "test-mode-a.md"), "tampered");
    expect(loadBuild(root, "0.0.0").reason).toBe("block-unavailable");
  });

  it("rejects a policy whose mode list omits public", () => {
    const root = fixture();
    const policyPath = join(root, "build", "policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { modes: string[] };
    policy.modes = ["test-mode-a"];
    writeFileSync(policyPath, JSON.stringify(policy));
    expect(loadBuild(root, "0.0.0").reason).toBe("policy-invalid");
  });

  it("rejects a switching route that is not owner verified", () => {
    const root = fixture();
    const policyPath = join(root, "build", "policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
      routes: Array<Record<string, unknown>>;
    };
    policy.routes[0] = { ...policy.routes[0], switching: "explicit", owner_verified: false };
    writeFileSync(policyPath, JSON.stringify(policy));
    expect(loadBuild(root, "0.0.0").reason).toBe("policy-invalid");
  });

  it("rejects a Date.parse-compatible timestamp that Python fromisoformat rejects", () => {
    const root = fixture();
    const manifestPath = join(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.built_at = "Thu, 01 Jan 2026 00:00:00 GMT";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(loadBuild(root, "0.0.0").reason).toBe("manifest-incompatible");
  });

  it("accepts Python fromisoformat-compatible basic and week timestamps", () => {
    for (const builtAt of [
      "20260101T1230.5Z",
      "2026W014",
      "2026-W01-4",
      "2026-W01-4🐍12:30:45+02:30",
      "2026-01-01Z",
      "2026-01-01T12:30:45+05:60",
    ]) {
      const root = fixture();
      const manifestPath = join(root, "build", "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.built_at = builtAt;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(loadBuild(root, "0.0.0").reason).toBeNull();
    }
  });

  it("rejects mixed basic and extended ISO week-date forms", () => {
    for (const builtAt of ["2026-W014", "2026W01-4"]) {
      const root = fixture();
      const manifestPath = join(root, "build", "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.built_at = builtAt;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(loadBuild(root, "0.0.0").reason).toBe("manifest-incompatible");
    }
  });

  it("rejects invalid UTF-8 in policy JSON instead of replacement-decoding it", () => {
    const root = fixture();
    const policyPath = join(root, "build", "policy.json");
    const policy = readFileSync(policyPath);
    const marker = Buffer.from('"audit_dir":"audit/"');
    const start = policy.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const corrupted = Buffer.from(policy);
    corrupted[start + '"audit_dir":"'.length] = 0x80;
    writeFileSync(policyPath, corrupted);
    expect(loadBuild(root, "0.0.0").reason).toBe("policy-unavailable");
  });

  it("rejects hash-valid mode bytes that are not strict UTF-8", () => {
    const root = fixture();
    const modePath = join(root, "build", "modes", "test-mode-a.md");
    const payload = Buffer.from([0x7b, 0x80, 0x7d]);
    writeFileSync(modePath, payload);
    const manifestPath = join(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      modes: Record<string, { bytes: number; tokens: number; sha256: string }>;
    };
    manifest.modes["test-mode-a"] = {
      ...manifest.modes["test-mode-a"],
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(loadBuild(root, "0.0.0").reason).toBe("block-unavailable");
  });

  it("uses the validated policy for route visibility when other artifacts fail", () => {
    const root = fixture();
    const manifestPath = join(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.engine_version = "1.0.0";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(loadBuild(root, "0.0.0").reason).toBe("manifest-incompatible");
    expect(resolveRouteContext({ session_key_rest: "voice-owner" }, root).route_id).toBe("voice-private");
  });

  it("falls back with an overlap reason when multiple routes match", () => {
    const root = fixture();
    const policyPath = join(root, "build", "policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { routes: unknown[] };
    policy.routes.push({
      id: "overlap",
      match: { session_key_rest: { prefix: "voice-" } },
      allowed_modes: ["public", "test-mode-a"],
      switching: "deny",
      state_domain: "private",
    });
    writeFileSync(policyPath, JSON.stringify(policy));
    const result = resolveRouteContext({ session_key_rest: "voice-owner" }, root);
    expect(result.route_id).toBe("__default__");
    expect(result.audit[0]?.reason).toBe("overlapping-routes");
  });
});
