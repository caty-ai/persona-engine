import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fsFault = vi.hoisted(() => ({
  auditPath: undefined as string | undefined,
  auditRoot: undefined as string | undefined,
  externalRoot: undefined as string | undefined,
  identityPath: undefined as string | undefined,
  identityLstatCalls: 0,
  openErrorPath: undefined as string | undefined,
  openErrorCode: undefined as string | undefined,
  verificationErrorPath: undefined as string | undefined,
  verificationErrorCode: undefined as string | undefined,
  verificationLstatCalls: 0,
  swapTriggerPath: undefined as string | undefined,
  swapBuildRoot: undefined as string | undefined,
  swapReplacementRoot: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>): Promise<Awaited<ReturnType<typeof actual.lstat>>> {
      if (fsFault.verificationErrorPath === String(args[0]) &&
          fsFault.verificationLstatCalls++ > 0 &&
          fsFault.verificationErrorCode !== undefined) {
        const code = fsFault.verificationErrorCode;
        fsFault.verificationErrorPath = undefined;
        throw Object.assign(new Error(`injected ${code ?? "lstat"} failure`), { code });
      }
      const result = await actual.lstat(...args);
      if (fsFault.identityPath !== String(args[0])) return result;
      const identity = fsFault.identityLstatCalls++ === 0
        ? 9_007_199_254_740_992n
        : 9_007_199_254_740_993n;
      const ino = (args[1] as { bigint?: boolean } | undefined)?.bigint === true
        ? identity
        : Number(identity);
      return new Proxy(result, {
        get(target, property) {
          if (property === "ino") return ino;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Awaited<ReturnType<typeof actual.lstat>>;
    },
    async open(...args: Parameters<typeof actual.open>): Promise<Awaited<ReturnType<typeof actual.open>>> {
      if (fsFault.openErrorPath === String(args[0])) {
        const code = fsFault.openErrorCode;
        fsFault.openErrorPath = undefined;
        throw Object.assign(new Error(`injected ${code ?? "open"} failure`), { code });
      }
      if (fsFault.swapTriggerPath === String(args[0]) &&
          fsFault.swapBuildRoot !== undefined &&
          fsFault.swapReplacementRoot !== undefined) {
        const buildRoot = fsFault.swapBuildRoot;
        const replacementRoot = fsFault.swapReplacementRoot;
        fsFault.swapTriggerPath = undefined;
        fsFault.swapBuildRoot = undefined;
        fsFault.swapReplacementRoot = undefined;
        await actual.rename(buildRoot, `${buildRoot}.previous`);
        await actual.rename(replacementRoot, buildRoot);
      }
      if (fsFault.auditPath === String(args[0]) &&
          fsFault.auditRoot !== undefined &&
          fsFault.externalRoot !== undefined) {
        const auditRoot = fsFault.auditRoot;
        const externalRoot = fsFault.externalRoot;
        fsFault.auditPath = undefined;
        fsFault.auditRoot = undefined;
        fsFault.externalRoot = undefined;
        await actual.rename(auditRoot, `${auditRoot}.original`);
        await actual.symlink(externalRoot, auditRoot, "dir");
      }
      const handle = await actual.open(...args);
      if (fsFault.identityPath !== String(args[0])) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") {
            return async (...statArgs: Parameters<typeof target.stat>) => {
              const result = await target.stat(...statArgs);
              const identity = 9_007_199_254_740_992n;
              const ino = (statArgs[0] as { bigint?: boolean } | undefined)?.bigint === true
                ? identity
                : Number(identity);
              return new Proxy(result, {
                get(statTarget, statProperty) {
                  if (statProperty === "ino") return ino;
                  const value = Reflect.get(statTarget, statProperty, statTarget) as unknown;
                  return typeof value === "function" ? value.bind(statTarget) : value;
                },
              });
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Awaited<ReturnType<typeof actual.open>>;
    },
  };
});

import { report_adapter_error, set, turn } from "../../src/turn/index.js";
import type { AdapterErrorContext, SetInput, TurnInput } from "../../src/types.js";

type RuntimeCaseCommon = {
  id: string;
  expected: unknown;
  expected_status?: unknown;
};

type RuntimeCase = RuntimeCaseCommon & (
  | { operation: "turn"; input: TurnInput }
  | { operation: "set"; input: SetInput }
  | {
      operation: "report_adapter_error";
      input: {
        error: { name?: string; message: string };
        ctx: Omit<AdapterErrorContext, "installRoot" | "now" | "warn">;
      };
    }
);

const casesRoot = resolve(
  import.meta.dirname,
  "../../../../spec/fixtures/runtime/cases",
);
const temporaryRoots: string[] = [];

async function temporaryCase(caseName: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), `persona-runtime-${caseName}-`));
  temporaryRoots.push(root);
  await cp(resolve(casesRoot, caseName), root, { recursive: true });
  return root;
}

function normalizeTimestamps(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.map((item, index) => normalizeTimestamps(item, expected[index]));
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const result: Record<string, unknown> = {};
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    for (const [key, value] of Object.entries(actualRecord)) {
      if (key === "ts") {
        expect(typeof value).toBe("string");
        if (typeof value === "string") {
          const parsed = Date.parse(value);
          expect(Number.isFinite(parsed)).toBe(true);
          if (Number.isFinite(parsed)) expect(new Date(parsed).toISOString()).toBe(value);
        }
        result[key] = expectedRecord[key];
      } else {
        result[key] = normalizeTimestamps(value, expectedRecord[key]);
      }
    }
    return result;
  }
  return actual;
}

afterEach(async () => {
  fsFault.auditPath = undefined;
  fsFault.auditRoot = undefined;
  fsFault.externalRoot = undefined;
  fsFault.identityPath = undefined;
  fsFault.identityLstatCalls = 0;
  fsFault.openErrorPath = undefined;
  fsFault.openErrorCode = undefined;
  fsFault.verificationErrorPath = undefined;
  fsFault.verificationErrorCode = undefined;
  fsFault.verificationLstatCalls = 0;
  fsFault.swapTriggerPath = undefined;
  fsFault.swapBuildRoot = undefined;
  fsFault.swapReplacementRoot = undefined;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const caseNames = (await readdir(casesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("turn/set runtime conformance", () => {
  it("discovers runtime fixtures", () => {
    expect(caseNames.length).toBeGreaterThan(0);
  });

  for (const caseName of caseNames) {
    it(caseName, async () => {
      const installRoot = await temporaryCase(caseName);
      const fixture = JSON.parse(
        await readFile(resolve(installRoot, "case.json"), "utf8"),
      ) as RuntimeCase;
      expect(fixture.id).toBe(caseName);

      const deps = { installRoot, engineVersion: "0.0.0" };
      let actual: unknown;
      if (fixture.operation === "turn") {
        actual = await turn(fixture.input, deps);
      } else if (fixture.operation === "set") {
        actual = await set(fixture.input, deps);
      } else {
        const error = new Error(fixture.input.error.message);
        if (fixture.input.error.name !== undefined) error.name = fixture.input.error.name;
        error.stack = "STACK-MUST-NOT-BE-LOGGED";
        actual = await report_adapter_error(error, {
          installRoot,
          ...fixture.input.ctx,
        });

        const auditText = await readFile(resolve(installRoot, "audit/audit.jsonl"), "utf8");
        const statusText = await readFile(resolve(installRoot, "state/status.json"), "utf8");
        expect(auditText).not.toContain(error.message);
        expect(statusText).not.toContain(error.message);
        expect(auditText).not.toContain(error.stack);
        expect(statusText).not.toContain(error.stack);
        if (fixture.input.ctx.route_id !== undefined) {
          expect(auditText).not.toContain(fixture.input.ctx.route_id);
        }
        if (fixture.input.ctx.turn_key !== undefined) {
          expect(auditText).not.toContain(fixture.input.ctx.turn_key);
        }
        const persistedAudit = auditText.trim().split("\n").map((line) => JSON.parse(line) as unknown);
        expect(normalizeTimestamps(persistedAudit, (fixture.expected as { audit: unknown }).audit))
          .toEqual((fixture.expected as { audit: unknown }).audit);
      }

      expect(normalizeTimestamps(actual, fixture.expected)).toEqual(fixture.expected);
      if (fixture.expected_status !== undefined) {
        const status = JSON.parse(
          await readFile(resolve(installRoot, "state/status.json"), "utf8"),
        ) as unknown;
        expect(normalizeTimestamps(status, fixture.expected_status)).toEqual(fixture.expected_status);
      }
    });
  }

  it("keeps utterance and block payloads out of audit and status files", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const utterance = "OPAQUE-UTTERANCE-MUST-NOT-BE-LOGGED";
    const transition = await set(
      {
        actor: "agent",
        ctx: { platform: "dummy" },
        requested_mode: "focus",
      },
      { installRoot, engineVersion: "0.0.0" },
    );
    expect(transition.ok).toBe(true);
    expect((await stat(resolve(installRoot, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(installRoot, "audit"))).mode & 0o777).toBe(0o700);

    const resolved = await turn(
      {
        ctx: { platform: "dummy" },
        actor: "unknown",
        utterance,
        turn_key: "dummy-turn-42",
      },
      { installRoot, engineVersion: "0.0.0" },
    );
    const block = await readFile(resolve(installRoot, "build/modes/focus.md"), "utf8");
    expect(resolved.block).toBe(block);

    const audit = await readFile(resolve(installRoot, "audit/audit.jsonl"), "utf8");
    const status = await readFile(resolve(installRoot, "state/status.json"), "utf8");
    expect(audit).not.toContain(utterance);
    expect(status).not.toContain(utterance);
    expect(audit).not.toContain(block);
    expect(status).not.toContain(block);
    const parsedStatus = JSON.parse(status) as Record<string, unknown>;
    expect(typeof parsedStatus.ts).toBe("string");
    expect(new Date(parsedStatus.ts as string).toISOString()).toBe(parsedStatus.ts);
    expect(parsedStatus).toEqual({
      ts: parsedStatus.ts,
      route_id: "agent-route",
      mode: "focus",
      block_sha256: createHash("sha256").update(block, "utf8").digest("hex"),
      block_bytes: Buffer.byteLength(block, "utf8"),
      engine: "ts@0.0.0",
      turn_key: "dummy-turn-42",
    });
  });

  it("reports only an adapter error category, never its message, stack, or ctx values", async () => {
    const installRoot = await temporaryCase("minimal-turn");
    const error = new Error("dummy adapter failure");
    error.stack = "STACK-MUST-NOT-BE-LOGGED";
    const context: AdapterErrorContext = {
      installRoot,
      route_id: "CTX-ROUTE-MUST-NOT-BE-LOGGED",
      turn_key: "CTX-TURN-MUST-NOT-BE-LOGGED",
    };

    const report = await report_adapter_error(error, context);
    expect(report.degraded).toBe(false);
    const audit = await readFile(resolve(installRoot, "audit/audit.jsonl"), "utf8");
    expect(audit).toContain('"reason":"Error"');
    expect(audit).not.toContain("dummy adapter failure");
    expect(audit).not.toContain(error.stack);
    expect(audit).not.toContain("CTX-ROUTE-MUST-NOT-BE-LOGGED");
    expect(audit).not.toContain("CTX-TURN-MUST-NOT-BE-LOGGED");
  });

  it("fails closed when report_adapter_error encounters a symlinked policy", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const policyPath = resolve(installRoot, "build/policy.json");
    const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-external-report-policy-"));
    temporaryRoots.push(externalRoot);
    const externalPolicyPath = resolve(externalRoot, "policy.json");
    const externalPolicy = JSON.parse(await readFile(policyPath, "utf8")) as {
      default_route: { state_domain: string };
    };
    externalPolicy.default_route.state_domain = "shared";
    await writeFile(externalPolicyPath, `${JSON.stringify(externalPolicy)}\n`, "utf8");
    await rm(policyPath);
    await symlink(externalPolicyPath, policyPath, "file");

    const report = await report_adapter_error(new Error("opaque"), { installRoot });

    expect(report.audit).toEqual([expect.objectContaining({
      event: "adapter_error",
      domain: "quarantine",
    })]);
    expect(report.audit[0]?.domain).not.toBe("shared");
  });

  it("rejects adapter-error reports without an explicit install root", async () => {
    await expect(report_adapter_error(
      new Error("must stay opaque"),
      {} as AdapterErrorContext,
    )).rejects.toThrow("report_adapter_error requires ctx.installRoot");
  });

  it("returns the resolved block with degraded true when audit realpath validation fails", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const externalAudit = await mkdtemp(resolve(tmpdir(), "persona-external-audit-"));
    temporaryRoots.push(externalAudit);
    const externalAuditFile = resolve(externalAudit, "audit.jsonl");
    await writeFile(externalAuditFile, "outside remains unchanged\n", "utf8");
    await rm(resolve(installRoot, "audit"), { recursive: true, force: true });
    await symlink(externalAudit, resolve(installRoot, "audit"), "dir");

    const result = await turn(
      {
        ctx: { platform: "dummy" },
        actor: "owner",
        utterance: "/persona focus",
      },
      { installRoot, engineVersion: "0.0.0" },
    );
    expect(result).toMatchObject({
      mode: "focus",
      transitioned: true,
      degraded: true,
    });
    expect(result.block).toContain("dummy focus block content");
    expect(await readFile(externalAuditFile, "utf8")).toBe("outside remains unchanged\n");
  });

  it("rejects an intermediate audit-directory swap after open without writing outside", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const auditRoot = resolve(installRoot, "audit");
    const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-audit-swap-"));
    temporaryRoots.push(externalRoot);
    await mkdir(auditRoot);
    const outside = resolve(externalRoot, "audit.jsonl");
    await writeFile(outside, "outside remains unchanged\n", "utf8");
    fsFault.auditPath = resolve(await realpath(auditRoot), "audit.jsonl");
    fsFault.auditRoot = auditRoot;
    fsFault.externalRoot = externalRoot;

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.auditPath).toBeUndefined();
    expect(result).toMatchObject({ mode: "focus", transitioned: true, degraded: true });
    expect(await readFile(outside, "utf8")).toBe("outside remains unchanged\n");
  });

  it("keeps a post-load block snapshot stable across a successful transition", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const blockPath = resolve(installRoot, "build/modes/focus.md");
    const expectedBlock = await readFile(blockPath, "utf8");
    let removed = false;
    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      {
        installRoot,
        engineVersion: "0.0.0",
        now: () => {
          if (!removed) {
            rmSync(blockPath);
            removed = true;
          }
          return new Date("2026-01-01T00:00:00.000Z");
        },
      },
    );

    expect(result).toMatchObject({ mode: "focus", transitioned: true });
    expect(result.block).toBe(expectedBlock);
    await expect(readFile(blockPath, "utf8")).rejects.toThrow();
  });

  it("fails F3 before transition when block bytes do not match the manifest", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    await writeFile(resolve(installRoot, "build/modes/focus.md"), "tampered block\n", "utf8");

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "block-unavailable",
    }));
    await expect(readFile(resolve(installRoot, "state/shared.json"), "utf8")).rejects.toThrow();
  });

  it("rejects a mode-directory replacement during a guarded block read", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const modesRoot = resolve(installRoot, "build/modes");
    const replacementRoot = resolve(installRoot, "build/modes.next");
    await cp(modesRoot, replacementRoot, { recursive: true });
    fsFault.swapTriggerPath = resolve(modesRoot, "focus.md");
    fsFault.swapBuildRoot = modesRoot;
    fsFault.swapReplacementRoot = replacementRoot;

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.swapTriggerPath).toBeUndefined();
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "block-unavailable",
    }));
  });

  it.each(["manifest.json", "policy.json", "triggers.json"])(
    "rejects symlinked build/%s before transition and audits F3",
    async (artifact) => {
      const installRoot = await temporaryCase("agent-switch-accept");
      const artifactPath = resolve(installRoot, "build", artifact);
      const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-external-build-json-"));
      temporaryRoots.push(externalRoot);
      const externalArtifact = resolve(externalRoot, artifact);
      await writeFile(externalArtifact, await readFile(artifactPath));
      await rm(artifactPath);
      await symlink(externalArtifact, artifactPath, "file");

      const result = await turn(
        { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
        { installRoot, engineVersion: "0.0.0" },
      );

      expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
      const reason = artifact === "policy.json"
        ? "policy-unavailable"
        : "build-artifact-unavailable";
      expect(result.audit).toContainEqual(expect.objectContaining({
        event: "build_invalid",
        reason,
      }));
      await expect(readFile(resolve(installRoot, "state/shared.json"), "utf8")).rejects.toThrow();
      const persistedAudit = (await readFile(resolve(installRoot, "audit/audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      expect(persistedAudit).toContainEqual(expect.objectContaining({
        event: "build_invalid",
        reason,
      }));
    },
  );

  it("rejects a symlinked build directory before reading its JSON trust roots", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const buildRoot = resolve(installRoot, "build");
    const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-external-build-directory-"));
    temporaryRoots.push(externalRoot);
    const externalBuild = resolve(externalRoot, "build");
    await cp(buildRoot, externalBuild, { recursive: true });
    await rm(buildRoot, { recursive: true });
    await symlink(externalBuild, buildRoot, "dir");

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-unavailable",
    }));
    await expect(readFile(resolve(installRoot, "state/shared.json"), "utf8")).rejects.toThrow();
  });

  it("rejects a symlinked build/modes directory before reading mode blocks", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const modesRoot = resolve(installRoot, "build/modes");
    const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-external-modes-directory-"));
    temporaryRoots.push(externalRoot);
    const externalModes = resolve(externalRoot, "modes");
    await cp(modesRoot, externalModes, { recursive: true });
    await rm(modesRoot, { recursive: true });
    await symlink(externalModes, modesRoot, "dir");

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "block-unavailable",
    }));
  });

  it("rejects a symlinked mode block before transition", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const blockPath = resolve(installRoot, "build/modes/focus.md");
    const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-external-mode-block-"));
    temporaryRoots.push(externalRoot);
    const externalBlock = resolve(externalRoot, "focus.md");
    await writeFile(externalBlock, await readFile(blockPath));
    await rm(blockPath);
    await symlink(externalBlock, blockPath, "file");

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "block-unavailable",
    }));
  });

  it("rejects a whole-build replacement during the three-file read sequence", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const buildRoot = resolve(installRoot, "build");
    const replacementRoot = resolve(installRoot, "build.next");
    await cp(buildRoot, replacementRoot, { recursive: true });
    fsFault.swapTriggerPath = resolve(buildRoot, "manifest.json");
    fsFault.swapBuildRoot = buildRoot;
    fsFault.swapReplacementRoot = replacementRoot;

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.swapTriggerPath).toBeUndefined();
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "build-artifact-unavailable",
    }));
  });

  it.each([
    ["parent directory", "build"],
    ["leaf artifact", "build/policy.json"],
  ])("classifies ENOTDIR from the %s open as build-invalid", async (_label, relativePath) => {
    const installRoot = await temporaryCase("agent-switch-accept");
    fsFault.openErrorPath = resolve(installRoot, relativePath);
    fsFault.openErrorCode = "ENOTDIR";

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.openErrorPath).toBeUndefined();
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-unavailable",
    }));
  });

  it.each([
    ["parent directory", "build"],
    ["leaf artifact", "build/policy.json"],
  ])("classifies ELOOP from the %s open as build-invalid", async (_label, relativePath) => {
    const installRoot = await temporaryCase("agent-switch-accept");
    fsFault.openErrorPath = resolve(installRoot, relativePath);
    fsFault.openErrorCode = "ELOOP";

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.openErrorPath).toBeUndefined();
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-unavailable",
    }));
  });

  it("rechecks the leaf after a non-race open error", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const policyPath = resolve(installRoot, "build/policy.json");
    fsFault.openErrorPath = policyPath;
    fsFault.openErrorCode = "EACCES";
    fsFault.verificationErrorPath = policyPath;
    fsFault.verificationErrorCode = undefined;

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.openErrorPath).toBeUndefined();
    expect(fsFault.verificationLstatCalls).toBe(2);
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-unavailable",
    }));
  });

  it("classifies an ENOENT verification-stat failure as build-invalid", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const policyPath = resolve(installRoot, "build/policy.json");
    fsFault.verificationErrorPath = policyPath;
    fsFault.verificationErrorCode = "ENOENT";

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.verificationErrorPath).toBeUndefined();
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      domain: "quarantine",
      reason: "policy-unavailable",
    }));
  });

  it("test_malformed_policy_precedes_missing_manifest", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    await writeFile(resolve(installRoot, "build/policy.json"), "{}\n", "utf8");
    await rm(resolve(installRoot, "build/manifest.json"));

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-invalid",
    }));
  });

  it("test_bom_prefixed_manifest_is_rejected_as_build_invalid", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const manifestPath = resolve(installRoot, "build/manifest.json");
    const manifest = await readFile(manifestPath);
    await writeFile(manifestPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifest]));

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "build-artifact-unavailable",
    }));
  });

  it("rejects a FIFO JSON trust root without opening or blocking on it", async (context) => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const policyPath = resolve(installRoot, "build/policy.json");
    await rm(policyPath);
    const mkfifo = spawnSync("mkfifo", [policyPath], { encoding: "utf8" });
    if (mkfifo.error !== undefined && (mkfifo.error as NodeJS.ErrnoException).code === "ENOENT") {
      context.skip("mkfifo is unavailable on this platform");
      return;
    }
    expect(mkfifo.status, mkfifo.stderr).toBe(0);

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-unavailable",
    }));
  });

  it("compares build artifact inode identities with exact bigint semantics", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    fsFault.identityPath = resolve(installRoot, "build/policy.json");

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "owner", utterance: "/persona focus" },
      { installRoot, engineVersion: "0.0.0" },
    );

    expect(fsFault.identityLstatCalls).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ mode: "public", block: "", transitioned: false });
    expect(result.audit).toContainEqual(expect.objectContaining({
      event: "build_invalid",
      reason: "policy-unavailable",
    }));
  });

  it("retries a public set CAS exactly once on revision conflicts", async () => {
    const makeCompetingState = (revision: number) => JSON.stringify({
      v: 1,
      revision,
      mode: "public",
      set_by: "owner",
      set_at: "2026-01-01T00:00:00.000Z",
      route_id: "agent-route",
    }) + "\n";

    const successRoot = await temporaryCase("agent-switch-accept");
    await mkdir(resolve(successRoot, "state"));
    let successCalls = 0;
    const success = await set(
      { actor: "agent", ctx: { platform: "dummy" }, requested_mode: "focus" },
      {
        installRoot: successRoot,
        engineVersion: "0.0.0",
        now: () => {
          successCalls += 1;
          if (successCalls === 3) {
            writeFileSync(resolve(successRoot, "state/shared.json"), makeCompetingState(1), "utf8");
          }
          return new Date("2026-01-01T00:00:00.000Z");
        },
      },
    );
    expect(success).toMatchObject({ ok: true, mode: "focus", transitioned: true });
    expect(JSON.parse(await readFile(resolve(successRoot, "state/shared.json"), "utf8")))
      .toMatchObject({ revision: 2, mode: "focus" });

    const failureRoot = await temporaryCase("agent-switch-accept");
    await mkdir(resolve(failureRoot, "state"));
    let failureCalls = 0;
    const failure = await set(
      { actor: "agent", ctx: { platform: "dummy" }, requested_mode: "focus" },
      {
        installRoot: failureRoot,
        engineVersion: "0.0.0",
        now: () => {
          failureCalls += 1;
          if (failureCalls === 3) {
            writeFileSync(resolve(failureRoot, "state/shared.json"), makeCompetingState(1), "utf8");
          } else if (failureCalls === 5) {
            writeFileSync(resolve(failureRoot, "state/shared.json"), makeCompetingState(2), "utf8");
          }
          return new Date("2026-01-01T00:00:00.000Z");
        },
      },
    );
    expect(failure).toMatchObject({
      ok: false,
      mode: "public",
      transitioned: false,
      rejected: { reason: "state revision changed during the single transition retry" },
    });
    expect(JSON.parse(await readFile(resolve(failureRoot, "state/shared.json"), "utf8")))
      .toMatchObject({ revision: 2, mode: "public" });
  });

  it("rejects admin sets with missing or unknown explicit domains", async () => {
    const missingRoot = await temporaryCase("agent-switch-accept");
    const missing = await set(
      { actor: "admin", ctx: null, requested_mode: "focus" } as unknown as SetInput,
      { installRoot: missingRoot, engineVersion: "0.0.0" },
    );
    expect(missing).toMatchObject({
      ok: false,
      transitioned: false,
      rejected: { reason: "requested domain is required" },
    });

    const unknownRoot = await temporaryCase("agent-switch-accept");
    const unknown = await set(
      { actor: "admin", ctx: null, requested_mode: "focus", domain: "missing" },
      { installRoot: unknownRoot, engineVersion: "0.0.0" },
    );
    expect(unknown).toMatchObject({
      ok: false,
      transitioned: false,
      rejected: { reason: "requested domain does not exist" },
    });
  });

  it("refuses an audit.jsonl symlink while preserving block resolution", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    const externalRoot = await mkdtemp(resolve(tmpdir(), "persona-external-audit-file-"));
    temporaryRoots.push(externalRoot);
    const externalFile = resolve(externalRoot, "outside.jsonl");
    await writeFile(externalFile, "outside remains unchanged\n", "utf8");
    await mkdir(resolve(installRoot, "audit"));
    await symlink(externalFile, resolve(installRoot, "audit/audit.jsonl"), "file");

    const result = await turn(
      {
        ctx: { platform: "dummy" },
        actor: "owner",
        utterance: "/persona focus",
      },
      { installRoot, engineVersion: "0.0.0" },
    );
    expect(result).toMatchObject({ mode: "focus", transitioned: true, degraded: true });
    expect(await readFile(externalFile, "utf8")).toBe("outside remains unchanged\n");
  });

  it("returns the resolved block with degraded true when status replacement fails", async () => {
    const installRoot = await temporaryCase("agent-switch-accept");
    await set(
      { actor: "agent", ctx: { platform: "dummy" }, requested_mode: "focus" },
      { installRoot, engineVersion: "0.0.0" },
    );
    await mkdir(resolve(installRoot, "state/status.json"));

    const result = await turn(
      { ctx: { platform: "dummy" }, actor: "unknown" },
      { installRoot, engineVersion: "0.0.0" },
    );
    expect(result).toMatchObject({ mode: "focus", degraded: true });
    expect(result.block).toContain("dummy focus block content");
  });
});
