import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { buildPack } from "../../src/compile/index.js";
import { sha256 } from "../../src/compile/hash.js";
import { readAuditTail, runDoctor, type DoctorReport } from "../../src/doctor/index.js";
import type { PolicyJson, RouteDecl, TriggersJson } from "../../src/types.js";

// derive from the package manifest like the CLI does — a hard-coded literal
// broke on the first real version bump (0.0.0 -> 0.1.0)
const ENGINE_VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
    version: string;
  }
).version;
const BIN = resolve(import.meta.dirname, "../../bin/persona");
const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

type FixtureOptions = {
  runtime?: "generic" | "hermes" | "openclaw";
  routes?: readonly RouteDecl[];
};

function createFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), "persona-doctor-"));
  temporaryRoots.push(root);
  const pack = resolve(root, "pack");
  mkdirSync(resolve(pack, "modes"), { recursive: true });
  mkdirSync(resolve(root, "audit"), { recursive: true });
  mkdirSync(resolve(root, "state"), { recursive: true });
  writeFileSync(resolve(pack, "manifest.yml"), `schema_version: 2
pack_version: "0.1.0"
name: synthetic-pack
engine:
  min: "0.0.0"
  max: null
default_budget_tokens: 600
`, "utf8");
  writeFileSync(resolve(pack, "modes", "default.yml"), `sections:
  - id: persona
    text: synthetic doctor fixture
`, "utf8");
  writeFileSync(resolve(root, "install.yml"), `schema_version: 2
pack: ./pack
runtime: ${options.runtime ?? "generic"}
routes: ${JSON.stringify(options.routes ?? [])}
default_route:
  state_domain: default
audit:
  dir: audit/
`, "utf8");
  const result = buildPack({
    installFile: resolve(root, "install.yml"),
    packDir: pack,
    outputDir: resolve(root, "build"),
    engineVersion: ENGINE_VERSION,
    builtAt: "2026-07-12T00:00:00.000Z",
  });
  expect(result.ok).toBe(true);
  return root;
}

function doctor(root: string, extra: Partial<Parameters<typeof runDoctor>[0]> = {}): Promise<DoctorReport> {
  return runDoctor({ installRoot: root, engineVersion: ENGINE_VERSION, env: {}, ...extra });
}

function readPolicy(root: string): PolicyJson {
  return JSON.parse(readFileSync(resolve(root, "build", "policy.json"), "utf8")) as PolicyJson;
}

function route(overrides: Partial<RouteDecl> = {}): RouteDecl {
  return {
    id: "synthetic-route",
    match: {},
    allowed_modes: ["public"],
    switching: "deny",
    state_domain: "default",
    owner_verified: false,
    ...overrides,
  };
}

function writeAudit(root: string, events: readonly unknown[]): void {
  writeFileSync(
    resolve(root, "audit", "audit.jsonl"),
    `${events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function expectActionable(report: DoctorReport): void {
  for (const message of [...report.issues, ...report.warnings]) {
    expect(message).toMatch(/ — fix: \S/u);
  }
}

function createHermesProfile(root: string, enabled: boolean): string {
  const profile = resolve(root, enabled ? "profile-enabled" : "profile-disabled");
  mkdirSync(resolve(profile, "plugins", "persona-engine"), { recursive: true });
  mkdirSync(resolve(profile, "sessions"), { recursive: true });
  writeFileSync(resolve(profile, "config.yaml"), `plugins:\n  enabled: [${enabled ? "persona-engine" : "other-plugin"}]\n`, "utf8");
  if (enabled) {
    writeFileSync(resolve(profile, "plugins", "persona-engine", "plugin.yaml"), "name: synthetic\n", "utf8");
    writeFileSync(resolve(profile, "plugins", "persona-engine", "__init__.py"), "# synthetic\n", "utf8");
    writeFileSync(resolve(profile, "sessions", "sessions.json"), "{}\n", "utf8");
  }
  return profile;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("detects legacy manifest schema and engine compatibility failures", async () => {
    const schemaRoot = createFixture();
    const schemaManifestPath = resolve(schemaRoot, "build", "manifest.json");
    const schemaManifest = JSON.parse(readFileSync(schemaManifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(schemaManifestPath, `${JSON.stringify({ ...schemaManifest, schema_version: 3 })}\n`, "utf8");
    let report = await doctor(schemaRoot);
    expect(report.issues).toEqual(expect.arrayContaining([expect.stringContaining("does not match schema version 2") ]));

    const engineRoot = createFixture();
    const engineManifestPath = resolve(engineRoot, "build", "manifest.json");
    const engineManifest = JSON.parse(readFileSync(engineManifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(engineManifestPath, `${JSON.stringify({ ...engineManifest, engine_version: "1.0.0" })}\n`, "utf8");
    report = await doctor(engineRoot);
    expect(report.issues).toEqual(expect.arrayContaining([expect.stringContaining("is incompatible with CLI engine") ]));
    expectActionable(report);
  });

  it("detects a missing compiled block", async () => {
    const root = createFixture();
    unlinkSync(resolve(root, "build", "modes", "default.md"));
    const report = await doctor(root);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("block 'default' disappeared or became unreadable during scan"),
    ]));
  });

  it.each([
    ["policy.json", "{}\n"],
    ["triggers.json", "{}\n"],
  ])("treats invalid build/%s as an issue", async (file, contents) => {
    const root = createFixture();
    writeFileSync(resolve(root, "build", file), contents, "utf8");
    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining(`build/${file} cannot be checked`),
    ]));
    expect(report.warnings.some((message) => message.includes(`build/${file} cannot be checked`))).toBe(false);
    expectActionable(report);
  });

  it("redacts source text from malformed build policy JSON", async () => {
    const root = createFixture();
    const fakeSecret = "sk-ABCDEFGHIJKLMNOP";
    writeFileSync(
      resolve(root, "build", "policy.json"),
      `{\n  "embedded": "${fakeSecret}",\n  broken\n}\n`,
      "utf8",
    );

    const report = await doctor(root);

    expect(report.issues).toEqual(expect.arrayContaining([
      "build/policy.json is not valid JSON — fix: rebuild with persona build",
    ]));
    expect(JSON.stringify(report)).not.toContain(fakeSecret);
  });

  it("treats an unreadable policy.json as an issue", async () => {
    const root = createFixture();
    const path = resolve(root, "build", "policy.json");
    chmodSync(path, 0o000);
    try {
      const report = await doctor(root);
      expect(report.ok).toBe(false);
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.stringContaining("build/policy.json is unreadable"),
      ]));
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("treats an absent policy.json as an issue and returns a nonzero CLI exit", async () => {
    const root = createFixture();
    unlinkSync(resolve(root, "build", "policy.json"));

    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("build/policy.json is missing"),
    ]));

    try {
      await execFileAsync(BIN, ["doctor", "--dir", root], { encoding: "utf8" });
      throw new Error("persona doctor unexpectedly exited successfully");
    } catch (error) {
      expect(error).toMatchObject({ code: 1 });
      const cliReport = JSON.parse((error as { stdout: string }).stdout) as DoctorReport;
      expect(cliReport.ok).toBe(false);
      expect(cliReport.issues).toEqual(expect.arrayContaining([
        expect.stringContaining("build/policy.json is missing"),
      ]));
    }
  });

  it("detects a runtime-valid policy artifact modified after build", async () => {
    const root = createFixture({
      runtime: "hermes",
      routes: [route({
        id: "tamper-target",
        match: { platform: "telegram", session_id: "conversation-1" },
        owner_verified: false,
      })],
    });
    const policy = readPolicy(root);
    const target = policy.routes[0];
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("fixture route is missing");
    target.owner_verified = true;
    writeFileSync(resolve(root, "build", "policy.json"), `${JSON.stringify(policy)}\n`, "utf8");

    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("build/policy.json does not match current pack+install inputs (post-build modification?)"),
    ]));
  });

  it("preserves legacy block and content-hash regressions as actionable issues", async () => {
    const root = createFixture();
    const block = resolve(root, "build", "modes", "default.md");
    writeFileSync(block, `${readFileSync(block, "utf8")}tampered`, "utf8");
    let report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("byte count differs from manifest"),
      expect.stringContaining("token count differs from pe-count-v1"),
      expect.stringContaining("sha256 differs from manifest"),
    ]));
    expectActionable(report);

    const root2 = createFixture();
    const source = resolve(root2, "pack", "modes", "default.yml");
    writeFileSync(source, `${readFileSync(source, "utf8")}# changed\n`, "utf8");
    report = await doctor(root2);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("content_hash does not match current pack inputs"),
    ]));
  });

  it("detects a tampered block even when its manifest metadata is updated consistently", async () => {
    const root = createFixture();
    const blockPath = resolve(root, "build", "modes", "default.md");
    const contents = `${readFileSync(blockPath, "utf8")}tampered consistently\n`;
    writeFileSync(blockPath, contents, "utf8");
    const manifestPath = resolve(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      modes: Record<string, { bytes: number; tokens: number; sha256: string }>;
    };
    manifest.modes.default = {
      bytes: Buffer.byteLength(contents),
      tokens: Math.ceil(Buffer.byteLength(contents) / 3),
      sha256: sha256(contents),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const report = await doctor(root);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("build block 'default' does not match current pack+install inputs"),
    ]));
  });

  it("reports only one manifest issue when manifest.json cannot be read", async () => {
    const root = createFixture();
    const manifestPath = resolve(root, "build", "manifest.json");
    chmodSync(manifestPath, 0o000);
    try {
      const report = await doctor(root);
      expect(report.issues.filter((message) => message.includes("build/manifest.json"))).toHaveLength(1);
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.stringContaining("build/manifest.json is unreadable"),
      ]));
    } finally {
      chmodSync(manifestPath, 0o600);
    }
  });

  it("redacts source text from pack YAML compiler diagnostics", async () => {
    const root = createFixture();
    const fakeSecret = "sk-ABCDEFGHIJKLMNOP";
    writeFileSync(
      resolve(root, "pack", "modes", "default.yml"),
      `sections:\n  - id: persona\n    text: [${fakeSecret}\n`,
      "utf8",
    );
    const report = await doctor(root);
    expect(report.issues).toEqual(expect.arrayContaining([expect.stringContaining("E_PARSE:")]));
    expect(JSON.stringify(report)).not.toContain(fakeSecret);
  });

  it("warns only above the audit failure-rate threshold with at least ten events", async () => {
    const root = createFixture();
    const ok = { event: "mode_resolved" };
    writeAudit(root, [
      { event: "route_unresolved" },
      { event: "resolve_downgrade" },
      ...Array.from({ length: 8 }, () => ok),
    ]);
    let report = await doctor(root);
    expect(report.warnings.some((message) => message.includes("failure-event share"))).toBe(false);

    writeAudit(root, [
      { event: "route_unresolved" },
      { event: "resolve_downgrade" },
      { event: "adapter_error" },
      ...Array.from({ length: 7 }, () => ok),
    ]);
    report = await doctor(root);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("failure-event share is 0.300 (3/10)"),
    ]));
    expect(report.ok).toBe(true);
    expectActionable(report);
  });

  it("counts malformed audit lines as warnings without crashing", async () => {
    const root = createFixture();
    writeAudit(root, ["not-json", { event: "mode_resolved" }]);
    const report = await doctor(root);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("1 malformed line") ]));
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining("malformed_lines=1") ]));
  });

  it("samples the final 500 physical audit lines before parsing", async () => {
    const root = createFixture();
    writeAudit(root, [
      ...Array.from({ length: 10 }, () => ({ event: "route_unresolved" })),
      ...Array.from({ length: 500 }, () => ({ event: "mode_resolved" })),
    ]);
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("valid_events=500, failure_events=0"),
    ]));
    expect(report.warnings.some((message) => message.includes("failure-event share"))).toBe(false);
  });

  it("samples only the tail of a large audit file while preserving the final 500 records", async () => {
    const root = createFixture();
    writeAudit(root, [
      { event: "route_unresolved", padding: "x".repeat(2 * 1024 * 1024 + 128) },
      ...Array.from({ length: 500 }, () => ({ event: "mode_resolved" })),
    ]);
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("valid_events=500, failure_events=0, malformed_lines=0"),
    ]));
    expect(report.warnings.some((message) => message.includes("failure-event share"))).toBe(false);
  });

  it("uses the bounded tail path for a 1.5 MiB audit file", async () => {
    const root = createFixture();
    writeAudit(root, [
      { event: "route_unresolved", padding: "x".repeat(Math.floor(1.5 * 1024 * 1024)) },
      ...Array.from({ length: 10 }, () => ({ event: "mode_resolved" })),
    ]);
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("valid_events=10, failure_events=0, malformed_lines=0"),
    ]));
  });

  it("never reads more than 1 MiB while sampling an audit file", async () => {
    const root = createFixture();
    const auditPath = resolve(root, "audit", "audit.jsonl");
    writeFileSync(auditPath, `${"x".repeat(2 * 1024 * 1024)}\n`, "utf8");

    const result = await readAuditTail(auditPath);

    expect(result.bytesRead).toBeLessThanOrEqual(1024 * 1024);
  });

  it("ignores a final partial audit line and notes a likely mid-write", async () => {
    const root = createFixture();
    writeFileSync(
      resolve(root, "audit", "audit.jsonl"),
      `${JSON.stringify({ event: "mode_resolved" })}\n{"event":"route_unresolved"`,
      "utf8",
    );
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("valid_events=1, failure_events=0, malformed_lines=0"),
      "last audit line appears mid-write",
    ]));
    expect(report.warnings.some((message) => message.includes("malformed line"))).toBe(false);
  });

  it("rejects an audit directory symlink that escapes the install root", async () => {
    const root = createFixture();
    const outside = mkdtempSync(resolve(tmpdir(), "persona-doctor-audit-outside-"));
    temporaryRoots.push(outside);
    rmSync(resolve(root, "audit"), { recursive: true });
    symlinkSync(outside, resolve(root, "audit"), "dir");

    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("compiled audit directory is unsafe"),
      expect.stringContaining("escapes install root"),
    ]));
  });

  it("reports an audit_dir that is a regular file", async () => {
    const root = createFixture();
    rmSync(resolve(root, "audit"), { recursive: true });
    writeFileSync(resolve(root, "audit"), "not a directory\n", "utf8");
    const report = await doctor(root);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("audit_dir is not a directory — fix: rebuild or remove the file"),
    ]));
  });

  it("reports a dangling audit_dir symlink specifically", async () => {
    const root = createFixture();
    rmSync(resolve(root, "audit"), { recursive: true });
    symlinkSync(resolve(root, "missing-audit"), resolve(root, "audit"), "dir");
    const report = await doctor(root);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("audit_dir is a dangling symlink — fix: recreate the audit directory"),
    ]));
  });

  it("checks a complete Hermes profile without emitting Hermes warnings", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, true);
    const report = await doctor(root, { hermesConfig: resolve(profile, "config.yaml") });
    expect(report.warnings.filter((message) => message.includes("Hermes"))).toEqual([]);
  });

  it("derives the Hermes profile from PERSONA_ENGINE_SESSIONS_FILE", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, true);
    const report = await doctor(root, {
      env: { PERSONA_ENGINE_SESSIONS_FILE: resolve(profile, "sessions", "sessions.json") },
    });
    expect(report.warnings.filter((message) => message.includes("Hermes"))).toEqual([]);
  });

  it("warns when a sessions symlink escapes the canonical Hermes profile", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, true);
    const outside = mkdtempSync(resolve(tmpdir(), "persona-doctor-sessions-outside-"));
    temporaryRoots.push(outside);
    writeFileSync(resolve(outside, "sessions.json"), "{}\n", "utf8");
    rmSync(resolve(profile, "sessions"), { recursive: true });
    symlinkSync(outside, resolve(profile, "sessions"), "dir");

    const report = await doctor(root, {
      env: { PERSONA_ENGINE_SESSIONS_FILE: resolve(profile, "sessions", "sessions.json") },
    });
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("sessions path escapes the profile root (symlink)"),
    ]));
  });

  it("warns when a dangling sessions symlink points outside the Hermes profile", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, true);
    const outside = mkdtempSync(resolve(tmpdir(), "persona-doctor-sessions-dangling-outside-"));
    temporaryRoots.push(outside);
    const sessionsPath = resolve(profile, "sessions", "sessions.json");
    unlinkSync(sessionsPath);
    symlinkSync(resolve(outside, "missing-sessions.json"), sessionsPath, "file");

    const report = await doctor(root, { hermesConfig: resolve(profile, "config.yaml") });

    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("sessions path escapes the profile root (dangling symlink)"),
    ]));
  });

  it("uses missing-file handling for a dangling sessions symlink that stays inside the profile", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, true);
    const sessionsPath = resolve(profile, "sessions", "sessions.json");
    unlinkSync(sessionsPath);
    symlinkSync(resolve(profile, "sessions", "missing-sessions.json"), sessionsPath, "file");

    const report = await doctor(root, { hermesConfig: resolve(profile, "config.yaml") });

    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Hermes sessions.json is missing or unreadable"),
    ]));
    expect(report.warnings.some((message) => message.includes("sessions path escapes"))).toBe(false);
  });

  it("rejects an unsafe Hermes sessions env layout", async () => {
    const root = createFixture({ runtime: "hermes" });
    const report = await doctor(root, {
      env: { PERSONA_ENGINE_SESSIONS_FILE: resolve(root, "profile", "sessions", "..", "outside", "sessions.json") },
    });
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Hermes host checks were skipped because no safe profile location was available"),
    ]));
  });

  it("warns for disabled/missing Hermes plugin files and broken sessions JSON", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, false);
    writeFileSync(resolve(profile, "sessions", "sessions.json"), "[]\n", "utf8");
    const report = await doctor(root, { hermesConfig: resolve(profile, "config.yaml") });
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("does not enable persona-engine"),
      expect.stringContaining("plugin.yaml is missing"),
      expect.stringContaining("__init__.py is missing"),
      expect.stringContaining("sessions.json is not valid JSON"),
    ]));
    expect(report.ok).toBe(true);
  });

  it("gives --hermes-config precedence over PERSONA_ENGINE_SESSIONS_FILE", async () => {
    const root = createFixture({ runtime: "hermes" });
    const profile = createHermesProfile(root, true);
    const result = await execFileAsync(
      BIN,
      ["doctor", "--dir", root, "--hermes-config", resolve(profile, "config.yaml")],
      {
        encoding: "utf8",
        env: { ...process.env, PERSONA_ENGINE_SESSIONS_FILE: resolve(root, "bad", "sessions", "sessions.json") },
      },
    );
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.warnings.filter((message) => message.includes("Hermes"))).toEqual([]);
  });

  it("warns for a group-capable bare platform but not api_server", async () => {
    const root = createFixture({ runtime: "hermes", routes: [
      route({ id: "telegram-owner", match: { platform: "telegram" }, owner_verified: true }),
      route({ id: "api-owner", match: { platform: "api_server" }, owner_verified: true }),
    ] });
    const report = await doctor(root);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("telegram-owner") ]));
    expect(report.warnings.some((message) => message.includes("api-owner") && message.includes("group-capable"))).toBe(false);
  });

  it("warns when an api_server route matches the unavailable session_key", async () => {
    const root = createFixture({ runtime: "hermes", routes: [route({
      match: { platform: "api_server", session_key: { prefix: "private-" } },
      owner_verified: true,
    })] });
    const report = await doctor(root);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("dead per the measured Hermes mapping") ]));
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining("session_key never reaches llm_request middleware") ]));
  });

  it("gates Hermes-attributed route diagnostics on the Hermes runtime", async () => {
    const apiRoute = route({
      match: { platform: "api_server", session_key: { prefix: "private-" } },
      owner_verified: true,
    });
    const genericRoot = createFixture({ runtime: "hermes", routes: [apiRoute] });
    const genericInstall = readFileSync(resolve(genericRoot, "install.yml"), "utf8")
      .replace("runtime: hermes", "runtime: generic");
    writeFileSync(resolve(genericRoot, "install.yml"), genericInstall, "utf8");
    const generic = await doctor(genericRoot);
    expect(generic.warnings.some((message) => message.includes("measured Hermes mapping"))).toBe(false);
    expect(generic.notes.some((message) => message.includes("Hermes measured mapping"))).toBe(false);

    const hermes = await doctor(createFixture({ runtime: "hermes", routes: [apiRoute] }));
    expect(hermes.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("dead per the measured Hermes mapping"),
    ]));
    expect(hermes.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Hermes measured mapping"),
    ]));
  });

  it.each([
    ["empty equality", "session_id", ""],
    ["empty prefix", "session_key", { prefix: "" }],
  ])("does not treat a vacuous %s as group-session scoping", async (_label, key, constraint) => {
    const routeId = `vacuous-${key.replaceAll("_", "-")}`;
    const scopedRoute = route({
      id: routeId,
      match: { platform: "telegram", [key]: constraint },
      owner_verified: true,
    });
    const root = createFixture({ runtime: "hermes", routes: [scopedRoute] });
    const report = await doctor(root);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(`route '${routeId}' owner-verifies a bare telegram platform match`),
    ]));
  });

  it("lints unresolved alias placeholders", async () => {
    const root = createFixture();
    const triggers = JSON.parse(readFileSync(resolve(root, "build", "triggers.json"), "utf8")) as TriggersJson;
    triggers.aliases["{{VOICE_ALIAS}}"] = "default";
    writeFileSync(resolve(root, "build", "triggers.json"), `${JSON.stringify(triggers)}\n`, "utf8");
    const report = await doctor(root);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Issue #53") ]));
  });

  it("gates the shared-memory warning on non-public allowed modes", async () => {
    const publicRoot = createFixture({ routes: [route({ allowed_modes: ["public"] })] });
    let report = await doctor(publicRoot);
    expect(report.warnings.some((message) => message.includes("shared-memory"))).toBe(false);

    const privateRoot = createFixture({ routes: [route({ allowed_modes: ["public", "default"] })] });
    report = await doctor(privateRoot);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("shared-memory") ]));
  });

  it.each([
    ["OpenAI-style API key", "sk-ABCDEFGHIJKLMNOP"],
    ["Slack bot/app token", "xoxb-synthetic-token"],
    ["Slack bot/app token", "xapp-synthetic-token"],
    ["AWS access key", "AKIAABCDEFGHIJKLMNOP"],
    ["GitHub personal access token", "ghp_ABCDEFGHIJKLMNOPQRST"],
    ["private key", "-----BEGIN SYNTHETIC PRIVATE KEY-----"],
    ["JWT", "eyJABCDEFGHIJKLMNOPQRST.eyJ"],
  ])("detects %s without echoing the matched text", async (kind, secret) => {
    const root = createFixture();
    const blockPath = resolve(root, "build", "modes", "default.md");
    const contents = `synthetic ${secret}\n`;
    writeFileSync(blockPath, contents, "utf8");
    const manifestPath = resolve(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      modes: Record<string, { bytes: number; tokens: number; sha256: string }>;
    };
    manifest.modes.default = {
      bytes: Buffer.byteLength(contents),
      tokens: Math.ceil(Buffer.byteLength(contents) / 3),
      sha256: sha256(contents),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`'${kind}'`) ]));
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports a symlinked block through the O_NOFOLLOW open path", async () => {
    const root = createFixture();
    const blockPath = resolve(root, "build", "modes", "default.md");
    const target = resolve(root, "symlinked-block.md");
    writeFileSync(target, "synthetic sk-ABCDEFGHIJKLMNOP\n", "utf8");
    unlinkSync(blockPath);
    symlinkSync(target, blockPath, "file");

    const report = await doctor(root);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("block 'default' is a symlink; the runtime refuses symlinked blocks (O_NOFOLLOW)"),
    ]));
    expect(report.warnings.some((message) => message.includes("secret pattern"))).toBe(false);
  });

  it("reports a manifest-listed FIFO without blocking", async (context) => {
    const root = createFixture();
    const blockPath = resolve(root, "build", "modes", "default.md");
    unlinkSync(blockPath);
    const mkfifo = spawnSync("mkfifo", [blockPath], { encoding: "utf8" });
    if (mkfifo.error !== undefined && (mkfifo.error as NodeJS.ErrnoException).code === "ENOENT") {
      context.skip("mkfifo is unavailable on this platform");
      return;
    }
    expect(mkfifo.status, mkfifo.stderr).toBe(0);

    const report = await doctor(root);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("block 'default' is not a regular file — fix: rebuild"),
    ]));
  });

  it("always shows the SPEC §6.2 trust-boundary note for owner promotion", async () => {
    const root = createFixture({
      runtime: "hermes",
      routes: [route({ match: { platform: "api_server" }, owner_verified: true })],
    });
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining("SPEC §6.2 trust boundary") ]));
  });

  it("shows the SPEC §6.2 trust-boundary note for prefix-only owner promotion", async () => {
    const root = createFixture({
      runtime: "hermes",
      routes: [route({ match: { session_key: { prefix: "owner-" } }, owner_verified: true })],
    });
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining("SPEC §6.2 trust boundary") ]));
  });

  it("emits honest OpenClaw host-check notes", async () => {
    const root = createFixture({ runtime: "openclaw" });
    const report = await doctor(root);
    expect(report.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("allowPromptInjection !== false"),
      expect.stringContaining("voice-route prefix hook reachability is not checkable"),
      expect.stringContaining("tool-name collisions are not checkable"),
    ]));
  });

  it("warns when an OpenClaw compiled mode exceeds the documented 20000-character cap", async () => {
    const root = createFixture({ runtime: "openclaw" });
    const blockPath = resolve(root, "build", "modes", "default.md");
    const contents = "é".repeat(20_001);
    writeFileSync(blockPath, contents, "utf8");
    const manifestPath = resolve(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      modes: Record<string, { bytes: number; tokens: number; sha256: string }>;
    };
    manifest.modes.default = {
      bytes: Buffer.byteLength(contents),
      tokens: Math.ceil(Buffer.byteLength(contents) / 3),
      sha256: sha256(contents),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("mode 'default' has 20001 characters"),
      expect.stringContaining("20000 characters per file"),
      expect.stringContaining("docs/design-v2-proposal.md:139"),
    ]));
  });

  it("does not warn when an OpenClaw compiled mode is exactly 20000 characters", async () => {
    const root = createFixture({ runtime: "openclaw" });
    const blockPath = resolve(root, "build", "modes", "default.md");
    const contents = "é".repeat(20_000);
    writeFileSync(blockPath, contents, "utf8");
    const manifestPath = resolve(root, "build", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      modes: Record<string, { bytes: number; tokens: number; sha256: string }>;
    };
    manifest.modes.default = {
      bytes: Buffer.byteLength(contents),
      tokens: Math.ceil(Buffer.byteLength(contents) / 3),
      sha256: sha256(contents),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const report = await doctor(root);
    expect(report.ok).toBe(false);
    expect(report.warnings.some((message) => message.includes("bootstrapMaxChars"))).toBe(false);
  });

  it("returns CLI exit code zero for warnings-only reports", async () => {
    const root = createFixture();
    writeAudit(root, ["not-json", { event: "mode_resolved" }]);
    const result = await execFileAsync(BIN, ["doctor", "--dir", root], { encoding: "utf8" });
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
