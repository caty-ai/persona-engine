import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = resolve(import.meta.dirname, "../../bin/persona");
const MARKER = "DO-NOT-LEAK-THIS-SECTION-TEXT";
const VOICE_HINT = "DO-NOT-LEAK-THIS-VOICE-HINT";
const temporaryRoots: string[] = [];

async function runText(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync(BIN, args, { cwd: root, encoding: "utf8" });
  return result.stdout;
}

async function runJson(root: string, ...args: string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await runText(root, ...args)) as Record<string, unknown>;
}

async function runFailure(root: string, ...args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    await execFileAsync(BIN, args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof result.code === "number" ? result.code : -1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  }
  throw new Error("Expected persona CLI command to fail");
}

async function rewriteStatus(root: string, updates: Record<string, unknown>): Promise<void> {
  const path = resolve(root, "state", "status.json");
  const status = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...status, ...updates })}\n`, "utf8");
}

async function scaffold(options: { secondDomain?: boolean; customMode?: boolean } = {}): Promise<string> {
  const parent = await mkdtemp(resolve(tmpdir(), "persona-status-ux-"));
  temporaryRoots.push(parent);
  const root = resolve(parent, "install");
  await runJson(parent, "init", root);
  if (options.secondDomain === true) {
    await writeFile(resolve(root, "install.yml"), `schema_version: 2
pack: ./pack
runtime: generic
routes:
  - id: cli-admin
    match: {}
    allowed_modes: [public, default]
    switching: deny
    state_domain: default
default_route:
  state_domain: quarantine
audit:
  dir: audit/
`, "utf8");
  }
  if (options.customMode === true) {
    await writeFile(resolve(root, "pack", "modes", "default.yml"), `voice_hint: ${VOICE_HINT}
sections:
  - id: persona
    text: |
      ${MARKER}
`, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persona status UX CLI", () => {
  it("reports real state, manifest, routes, audit transitions, and never leaks mode content", async () => {
    const root = await scaffold({ customMode: true });
    await runJson(root, "build");

    expect(await runText(root, "get", "--domain", "default")).toContain("freshness: unavailable");
    await runJson(root, "set", "default", "--domain", "default");
    await runJson(root, "turn", "--domain", "default");
    await rewriteStatus(root, { route_id: "cli-admin" });

    const matching = await runJson(root, "get", "--domain", "default", "--json");
    expect(matching).toMatchObject({
      domain: "default",
      mode: "default",
      revision: 1,
      freshness: { available: true, matches_current_mode: true },
    });
    const lastInjected = (matching.freshness as { last_injected: Record<string, unknown> }).last_injected;
    expect(lastInjected).not.toHaveProperty("engine");
    expect(lastInjected).not.toHaveProperty("turn_key");

    await runJson(root, "set", "public", "--domain", "default");
    const stale = await runJson(root, "get", "--json", "--domain", "default");
    expect(stale).toMatchObject({
      domain: "default",
      mode: "public",
      revision: 2,
      freshness: { available: true, matches_current_mode: false },
    });

    const listed = await runJson(root, "list", "--json");
    expect(listed).toMatchObject({
      modes: [{ id: "default", bytes: expect.any(Number), tokens: expect.any(Number), has_voice_hint: true }],
      routes: [{
        id: "cli-admin",
        allowed_modes: ["public", "default"],
        switching: "deny",
        owner_verified: false,
      }],
      public_implicitly_allowed: true,
    });

    const audited = await runJson(root, "audit", "--json");
    expect(audited).toMatchObject({
      events: [
        { event: "mode_transition", domain: "default", from: "default", to: "public" },
        { event: "mode_transition", domain: "default", from: "public", to: "default" },
      ],
      skipped_malformed_lines: 0,
    });

    const outputs = await Promise.all([
      runText(root, "get", "--domain", "default"),
      runText(root, "get", "--domain", "default", "--json"),
      runText(root, "list"),
      runText(root, "list", "--json"),
      runText(root, "audit"),
      runText(root, "audit", "--json"),
    ]);
    for (const output of outputs) {
      expect(output).not.toContain(MARKER);
      expect(output).not.toContain(VOICE_HINT);
    }
  }, 30000);

  it("shows every domain and treats malformed status.json as unavailable", async () => {
    const root = await scaffold({ secondDomain: true });
    await runJson(root, "build");
    await runJson(root, "set", "default", "--domain", "default");
    await writeFile(resolve(root, "state", "status.json"), "not-json\n", "utf8");

    const human = await runText(root, "get");
    expect(human).toContain("Domain: default");
    expect(human).toContain("Domain: quarantine");
    expect(human).toContain("freshness: unavailable");

    const json = await runJson(root, "get", "--json");
    expect(json).toMatchObject({
      domains: [
        { domain: "default", mode: "default", revision: 1, freshness: { available: false } },
        { domain: "quarantine", mode: "public", revision: 0, freshness: { available: false } },
      ],
    });
    expect((json.domains as Array<Record<string, unknown>>)[1]).not.toHaveProperty("set_by");
    expect((json.domains as Array<Record<string, unknown>>)[1]).not.toHaveProperty("set_at");
  });

  it("does not echo invalid mode ids from state or status files", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await runJson(root, "set", "default", "--domain", "default");
    await runJson(root, "turn", "--domain", "default");

    const invalidStateMode = "INVALID-STATE-MODE-CONTENT";
    const statePath = resolve(root, "state", "default.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, `${JSON.stringify({ ...state, mode: invalidStateMode })}\n`, "utf8");
    const stateResult = await runFailure(root, "get", "--domain", "default", "--json");
    expect(stateResult.code).toBe(3);
    expect(stateResult.stdout).toContain('"mode": "<invalid-mode-id>"');
    expect(stateResult.stdout).toContain('"state_error": true');
    expect(stateResult.stdout).not.toContain(invalidStateMode);

    const validState = { ...state, mode: "default" };
    await writeFile(statePath, `${JSON.stringify(validState)}\n`, "utf8");
    const invalidStatusMode = "INVALID-STATUS-MODE-CONTENT";
    const statusPath = resolve(root, "state", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    await writeFile(statusPath, `${JSON.stringify({ ...status, mode: invalidStatusMode })}\n`, "utf8");
    const statusOutput = await runText(root, "get", "--domain", "default", "--json");
    expect(statusOutput).toContain('"freshness": {\n    "available": false');
    expect(statusOutput).not.toContain(invalidStatusMode);
  });

  it("caps display-boundary mode ids at 256 characters", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await runJson(root, "set", "default", "--domain", "default");
    const oversizedMode = "a".repeat(300);

    const statePath = resolve(root, "state", "default.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, `${JSON.stringify({ ...state, mode: oversizedMode })}\n`, "utf8");
    await writeFile(resolve(root, "audit", "audit.jsonl"), `${JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      event: "mode_transition",
      route_id: "cli-admin",
      domain: "default",
      from: oversizedMode,
      to: "public",
    })}\n`, "utf8");

    const [getHuman, getJson, auditHuman, auditJson] = await Promise.all([
      runFailure(root, "get", "--domain", "default"),
      runFailure(root, "get", "--domain", "default", "--json"),
      runText(root, "audit"),
      runText(root, "audit", "--json"),
    ]);
    expect(getHuman).toMatchObject({ code: 3, stderr: "" });
    expect(getHuman.stdout).toContain("mode: <invalid-mode-id>");
    expect(getHuman.stdout).toContain("state_error: true");
    expect(getJson).toMatchObject({ code: 3, stderr: "" });
    expect(getJson.stdout).toContain('"mode": "<invalid-mode-id>"');
    expect(getJson.stdout).toContain('"state_error": true');
    expect(JSON.parse(auditJson)).toEqual({ events: [], skipped_malformed_lines: 1 });
    expect(auditHuman).toContain("skipped 1 malformed lines");
    for (const output of [getHuman.stdout, getJson.stdout, auditHuman, auditJson]) {
      expect(output).not.toContain(oversizedMode);
    }
  });

  it("redacts oversized manifest mode ids from list output", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    const oversizedMode = "a".repeat(300);
    const manifestPath = resolve(root, "build", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      modes: Record<string, unknown>;
    };
    manifest.modes[oversizedMode] = manifest.modes.default;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const [human, json] = await Promise.all([
      runText(root, "list"),
      runText(root, "list", "--json"),
    ]);
    const listed = JSON.parse(json) as {
      modes: Array<{ id: string; data_error: boolean }>;
    };
    expect(listed.modes).toContainEqual(expect.objectContaining({
      id: "<invalid-mode-id>",
      data_error: true,
    }));
    expect(human).toContain("<invalid-mode-id>");
    expect(human).toContain("data_error=true");
    for (const output of [human, json]) {
      expect(output).not.toContain(oversizedMode);
    }
  });

  it("reports global status as not applicable outside its route domain", async () => {
    const root = await scaffold({ secondDomain: true });
    await runJson(root, "build");
    await runJson(root, "turn", "--domain", "default");
    await rewriteStatus(root, { route_id: "cli-admin" });

    const output = await runJson(root, "get", "--json");
    expect(output).toMatchObject({
      domains: [
        { domain: "default", freshness: { available: true, applicable: true, matches_current_mode: true } },
        { domain: "quarantine", freshness: { available: true, applicable: false } },
      ],
    });
    expect((output.domains as Array<Record<string, unknown>>)[1]?.freshness).not.toHaveProperty("matches_current_mode");
    expect(await runText(root, "get", "--domain", "quarantine")).toContain("freshness: not applicable to this domain");
  });

  it("filters audit JSONL, orders newest first, and reports malformed lines", async () => {
    const root = await scaffold({ secondDomain: true });
    await runJson(root, "build");
    await writeFile(resolve(root, "audit", "audit.jsonl"), [
      JSON.stringify({ ts: "2026-01-03T00:00:00.000Z", event: "mode_transition", route_id: "cli-admin", domain: "default", from: "default", to: "public", set_by: "admin" }),
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "mode_transition", route_id: "cli-admin", domain: "default", from: "public", to: "default", set_by: "admin", block: MARKER }),
      "not-json",
      JSON.stringify({ ts: "2026-02-30T00:00:00.000Z", event: "mode_transition", route_id: "cli-admin", domain: "default", from: "public", to: "default" }),
      JSON.stringify({ ts: "2026-01-04T00:00:00.000Z", event: "mode_transition", route_id: "cli-admin", domain: "default", from: "../../private", to: "public" }),
      JSON.stringify({ ts: "2026-01-04T00:00:00.000Z", event: "switch_rejected", route_id: "cli-admin", domain: "default", reason: "x".repeat(257) }),
      JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", event: "switch_rejected", route_id: "cli-admin", domain: "quarantine", reason: "test" }),
      "",
    ].join("\n"), "utf8");

    const all = await runJson(root, "audit", "--json");
    expect((all.events as Array<Record<string, unknown>>).map((event) => event.ts)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(all.skipped_malformed_lines).toBe(4);
    expect(JSON.stringify(all)).not.toContain(MARKER);

    const byDomain = await runJson(root, "audit", "--domain", "quarantine", "--json");
    expect((byDomain.events as Array<Record<string, unknown>>).map((event) => event.ts)).toEqual([
      "2026-01-02T00:00:00.000Z",
    ]);

    const bySince = await runJson(root, "audit", "--since", "2026-01-02T00:00:00.000Z", "--json");
    expect((bySince.events as Array<Record<string, unknown>>).map((event) => event.ts)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);

    const byLimit = await runJson(root, "audit", "--limit", "2", "--json");
    expect((byLimit.events as Array<Record<string, unknown>>).map((event) => event.ts)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);

    const filtered = await runJson(
      root,
      "audit",
      "--domain", "default",
      "--event", "mode_transition",
      "--since", "2026-01-02T00:00:00.000Z",
      "--limit", "1",
      "--json",
    );
    expect(filtered).toMatchObject({
      events: [{ ts: "2026-01-03T00:00:00.000Z", domain: "default", event: "mode_transition" }],
      skipped_malformed_lines: 4,
    });

    const rejected = await runJson(root, "audit", "--event", "switch_rejected", "--json");
    expect(rejected).toMatchObject({ events: [{ domain: "quarantine", event: "switch_rejected" }] });
    expect(await runText(root, "audit", "--limit", "1")).toMatch(/skipped 4 malformed lines\n$/u);
  });

  it("rejects a symlinked audit.jsonl without following it", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    const externalMarker = "SYMLINK-TARGET-MUST-NOT-BE-READ";
    const target = resolve(root, "..", "external-audit.jsonl");
    await writeFile(target, `${JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      event: externalMarker,
      route_id: "cli-admin",
      domain: "default",
    })}\n`, "utf8");
    await symlink(target, resolve(root, "audit", "audit.jsonl"));

    const result = await runFailure(root, "audit", "--json");
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(externalMarker);
  });

  it("rejects non-canonical calendar dates in status, audit, and --since", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await runJson(root, "turn", "--domain", "default");
    const statusPath = resolve(root, "state", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    await writeFile(statusPath, `${JSON.stringify({ ...status, ts: "2026-02-30T00:00:00.000Z" })}\n`, "utf8");
    await writeFile(resolve(root, "audit", "audit.jsonl"), `${JSON.stringify({
      ts: "2026-02-30T00:00:00.000Z",
      event: "mode_transition",
      route_id: "cli-admin",
      domain: "default",
      from: "public",
      to: "default",
    })}\n`, "utf8");

    await expect(runJson(root, "get", "--domain", "default", "--json")).resolves.toMatchObject({
      freshness: { available: false },
    });
    await expect(runJson(root, "audit", "--json")).resolves.toEqual({
      events: [],
      skipped_malformed_lines: 1,
    });
    await expect(runFailure(root, "audit", "--since", "2026-02-30T00:00:00.000Z")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("valid canonical ISO8601 timestamp"),
    });
  });

  it("returns zero events when audit.jsonl is absent", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await expect(runJson(root, "audit", "--json")).resolves.toEqual({
      events: [],
      skipped_malformed_lines: 0,
    });
    await expect(runText(root, "audit")).resolves.toContain("(none)");
  });

  it("maps build-less get, list, and audit to a clear build error", async () => {
    const root = await scaffold();
    for (const command of ["get", "list", "audit"]) {
      const result = await runFailure(root, command);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("build artifacts missing or invalid");
      expect(result.stderr).toContain("run persona build");
    }
  });

  it("rejects unknown domains and invalid audit filter values", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await expect(runFailure(root, "get", "--domain", "missing")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("unknown state domain 'missing'"),
    });
    await expect(runFailure(root, "audit", "--domain", "missing")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("unknown state domain 'missing'"),
    });
    await expect(runFailure(root, "audit", "--since", "yesterday")).resolves.toMatchObject({ code: 3 });
    await expect(runFailure(root, "audit", "--since", "2026")).resolves.toMatchObject({ code: 3 });
    await expect(runFailure(root, "audit", "--since", "2026-02-30T00:00:00.000Z")).resolves.toMatchObject({ code: 3 });
    await expect(runFailure(root, "audit", "--limit", "0")).resolves.toMatchObject({ code: 3 });
  });

  it("treats status sentinels as ambiguous when declared route ids collide", async () => {
    for (const sentinel of ["__default__", "__admin__"]) {
      const root = await scaffold({ customMode: true, secondDomain: true });
      await runJson(root, "build");
      await runJson(root, "turn", "--domain", "default");
      const policyPath = resolve(root, "build", "policy.json");
      const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
        routes: Array<{ id: string }>;
      };
      policy.routes[0]!.id = sentinel;
      await writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
      await rewriteStatus(root, { route_id: sentinel });

      const jsonText = await runText(root, "get", "--json");
      const output = JSON.parse(jsonText) as { domains: Array<Record<string, unknown>> };
      for (const domain of output.domains) {
        expect(domain).toMatchObject({
          freshness: {
            available: true,
            applicable: false,
            reason: "ambiguous_sentinel_collision",
          },
        });
      }
      const human = await runText(root, "get", "--domain", "default");
      expect(human).toContain("freshness: ambiguous");
      expect(human).toContain("collides with a reserved identifier");
      for (const rendered of [jsonText, human]) {
        expect(rendered).not.toContain(MARKER);
        expect(rendered).not.toContain(VOICE_HINT);
      }
    }
  }, 30000);

  it("redacts and flags unsafe state and policy display strings", async () => {
    const root = await scaffold({ customMode: true });
    await runJson(root, "build");
    await runJson(root, "set", "default", "--domain", "default");

    const statePath = resolve(root, "state", "default.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, `${JSON.stringify({
      ...state,
      v: 0,
      set_at: `not-canonical\n${MARKER}`,
      route_id: `unsafe-route\n${MARKER}`,
    })}\n`, "utf8");
    const stateResult = await runFailure(root, "get", "--domain", "default", "--json");
    expect(stateResult).toMatchObject({ code: 3, stderr: "" });
    expect(stateResult.stdout).toContain('"set_at": "<invalid-timestamp>"');
    expect(stateResult.stdout).toContain('"route_id": "<invalid-route-id>"');
    expect(stateResult.stdout).toContain('"state_error": true');
    expect(stateResult.stdout).not.toContain(MARKER);

    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
    await runJson(root, "turn", "--domain", "default");
    const unsafeStatusRoute = `unsafe-status-route\n${MARKER}`;
    await rewriteStatus(root, { route_id: unsafeStatusRoute });
    const statusOutput = await runText(root, "get", "--domain", "default", "--json");
    expect(statusOutput).toContain('"freshness": {\n    "available": false');
    expect(statusOutput).not.toContain(unsafeStatusRoute);
    expect(statusOutput).not.toContain(MARKER);

    const policyPath = resolve(root, "build", "policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      modes: string[];
      routes: Array<{ id: string; allowed_modes: string[] }>;
    };
    const unsafeMode = `bad\n${MARKER}`;
    policy.modes.push(unsafeMode);
    policy.routes[0]!.id = `unsafe\u001b[31m${MARKER}`;
    policy.routes[0]!.allowed_modes.push(unsafeMode);
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8");

    const listJson = await runText(root, "list", "--json");
    const listed = JSON.parse(listJson) as {
      routes: Array<{ id: string; allowed_modes: string[]; data_error: boolean }>;
    };
    expect(listed.routes[0]).toMatchObject({
      id: "<invalid-route-id>",
      allowed_modes: ["public", "default", "<invalid-mode-id>"],
      data_error: true,
    });
    const listHuman = await runText(root, "list");
    expect(listHuman).toContain("<invalid-route-id>");
    expect(listHuman).toContain("<invalid-mode-id>");
    expect(listHuman).toContain("data_error=true");
    for (const rendered of [listJson, listHuman]) {
      expect(rendered).not.toContain(MARKER);
      expect(rendered).not.toContain("\u001b");
    }
  });

  it("rejects audit reasons containing fabricated control-character output", async () => {
    const root = await scaffold({ customMode: true });
    await runJson(root, "build");
    const fabricated = `safe-prefix\n  2026-01-01T00:00:00.000Z fabricated route=trusted ${MARKER}`;
    await writeFile(resolve(root, "audit", "audit.jsonl"), `${JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      event: "switch_rejected",
      route_id: "cli-admin",
      domain: "default",
      reason: fabricated,
    })}\n`, "utf8");

    await expect(runJson(root, "audit", "--json")).resolves.toEqual({
      events: [],
      skipped_malformed_lines: 1,
    });
    const human = await runText(root, "audit");
    expect(human).not.toContain("fabricated route=trusted");
    expect(human).not.toContain(MARKER);
    expect(human.trim().split("\n")).toHaveLength(3);
  });

  it("does not follow a symlinked status.json", async () => {
    const root = await scaffold({ customMode: true });
    await runJson(root, "build");
    await runJson(root, "turn", "--domain", "default");
    const externalMarker = "symlink-target-route-must-not-appear";

    const policyPath = resolve(root, "build", "policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      routes: Array<{ id: string }>;
    };
    policy.routes[0]!.id = externalMarker;
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8");

    const statusPath = resolve(root, "state", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    const target = resolve(root, "..", "external-status.json");
    await writeFile(target, `${JSON.stringify({ ...status, route_id: externalMarker })}\n`, "utf8");
    await rm(statusPath);
    await symlink(target, statusPath);

    const stdout = await runText(root, "get", "--domain", "default", "--json");
    expect(JSON.parse(stdout)).toMatchObject({ freshness: { available: false } });
    expect(stdout).not.toContain(externalMarker);
    expect(stdout).not.toContain(MARKER);
    expect(stdout).not.toContain(VOICE_HINT);
  });

  it("treats invalid status hash, byte count, and engine as unavailable", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await runJson(root, "turn", "--domain", "default");
    const statusPath = resolve(root, "state", "status.json");
    const baseline = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;

    for (const update of [
      { block_sha256: "ABC" },
      { block_bytes: -1 },
      { engine: "ts@1.2" },
    ]) {
      await writeFile(statusPath, `${JSON.stringify({ ...baseline, ...update })}\n`, "utf8");
      await expect(runJson(root, "get", "--domain", "default", "--json")).resolves.toMatchObject({
        freshness: { available: false },
      });
    }
  });

  it("rejects negative, fractional, and nonnumeric audit limits", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await expect(runFailure(root, "audit", "--limit", "-5")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("positive integer"),
    });
    await expect(runFailure(root, "audit", "--limit", "2.5")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("positive integer"),
    });
    await expect(runFailure(root, "audit", "--limit", "abc")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("positive integer"),
    });
  });

  it("rejects an empty audit event filter", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await expect(runFailure(root, "audit", "--event", "")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("--event requires a value"),
    });
  });

  it("rejects stray audit positional arguments", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await expect(runFailure(root, "audit", "extra-arg")).resolves.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("usage: persona audit"),
    });
  });

  it("attributes a non-colliding default sentinel to the default-route domain", async () => {
    const root = await scaffold({ secondDomain: true });
    await runJson(root, "build");
    await runJson(root, "turn", "--domain", "default");
    await rewriteStatus(root, { route_id: "__default__" });

    const output = await runJson(root, "get", "--json");
    expect(output).toMatchObject({
      domains: [
        {
          domain: "default",
          freshness: { available: true, applicable: false, reason: "no_domain_match" },
        },
        { domain: "quarantine", freshness: { available: true, applicable: true } },
      ],
    });
  });

  it("rejects noncanonical missing-millisecond and lowercase-z timestamps", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    await runJson(root, "turn", "--domain", "default");
    const statusPath = resolve(root, "state", "status.json");
    const baseline = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    const timestamps = ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000z"];

    for (const ts of timestamps) {
      await writeFile(statusPath, `${JSON.stringify({ ...baseline, ts })}\n`, "utf8");
      await expect(runJson(root, "get", "--domain", "default", "--json")).resolves.toMatchObject({
        freshness: { available: false },
      });
      await expect(runFailure(root, "audit", "--since", ts)).resolves.toMatchObject({ code: 3 });
    }
    await writeFile(resolve(root, "audit", "audit.jsonl"), `${timestamps.map((ts) => JSON.stringify({
      ts,
      event: "mode_transition",
      route_id: "cli-admin",
      domain: "default",
    })).join("\n")}\n`, "utf8");
    await expect(runJson(root, "audit", "--json")).resolves.toEqual({
      events: [],
      skipped_malformed_lines: 2,
    });
  });

  it("preserves input order when audit timestamps tie", async () => {
    const root = await scaffold();
    await runJson(root, "build");
    const ts = "2026-01-01T00:00:00.000Z";
    await writeFile(resolve(root, "audit", "audit.jsonl"), `${["first", "second", "third"]
      .map((reason) => JSON.stringify({
        ts,
        event: "switch_rejected",
        route_id: "cli-admin",
        domain: "default",
        reason,
      }))
      .join("\n")}\n`, "utf8");

    const output = await runJson(root, "audit", "--json");
    expect((output.events as Array<Record<string, unknown>>).map((event) => event.reason)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
