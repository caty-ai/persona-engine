import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { OpenClawAdapter, PERSONA_SET_PARAMETERS, registerAdapter } from "../src/adapter.js";
import type { OpenClawPluginApi } from "../src/openclaw-types.js";
import { PRIVATE_BLOCK, writeBuild } from "./helpers.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "persona-openclaw-adapter-"));
  writeBuild(root);
  return root;
}

function core(overrides: Record<string, unknown> = {}) {
  return {
    turn: vi.fn(async () => ({
      mode: "test-mode-a",
      block: PRIVATE_BLOCK,
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    })),
    set: vi.fn(async () => ({ ok: true, mode: "test-mode-a", transitioned: true, audit: [] })),
    reportAdapterError: vi.fn(async () => ({ degraded: false, audit: [] })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("OpenClaw adapter", () => {
  it("deduplicates a concurrent session resolution and returns core bytes verbatim", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "hello", messages: [] };
    const ctx = { runId: "run-1", sessionId: "session-1", sessionKey: "agent:main:voice-owner" };
    const [first, second] = await Promise.all([
      adapter.beforePromptBuild(event, ctx),
      adapter.beforePromptBuild(event, ctx),
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);
    expect(fakeCore.turn).toHaveBeenCalledWith(expect.objectContaining({ actor: "owner", turn_key: "run-1" }), expect.anything());
    expect(first).toEqual({ appendSystemContext: PRIVATE_BLOCK });
    expect(second).toEqual(first);
  });

  it("does not deduplicate the same session across different raw route inputs", async () => {
    const fakeCore = core({
      turn: vi.fn(async (input: { ctx: Record<string, unknown> }) => input.ctx.session_key_rest === "voice-owner"
        ? { mode: "test-mode-a", block: PRIVATE_BLOCK, route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] }
        : { mode: "public", block: "", route_id: "__default__", state_domain: "quarantine", transitioned: false, audit: [] }),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "same prompt", messages: [] };
    const [publicResult, privateResult] = await Promise.all([
      adapter.beforePromptBuild(event, { sessionId: "shared-session", sessionKey: "agent:main:public" }),
      adapter.beforePromptBuild(event, { sessionId: "shared-session", sessionKey: "agent:main:voice-owner" }),
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
    expect(publicResult).toBeUndefined();
    expect(privateResult).toEqual({ appendSystemContext: PRIVATE_BLOCK });
  });

  it("joining a pending flight returns the same in-flight snapshot even if a transition happens concurrently", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>();
    const fakeCore = core({
      turn: vi.fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({ mode: "test-mode-a", block: "fresh", route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] }),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "same turn", messages: [] };
    const ctx = { sessionId: "shared-session", sessionKey: "agent:main:voice-owner" };
    const first = adapter.beforePromptBuild(event, ctx);
    const joined = adapter.beforePromptBuild(event, ctx);
    const tool = adapter.toolFactory({ sessionKey: "agent:main:voice-owner", senderIsOwner: true });
    await tool?.execute("transition", { mode: "test-mode-a" });
    pending.resolve({ mode: "test-mode-a", block: "stale", route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] });
    await expect(first).resolves.toEqual({ appendSystemContext: "stale" });
    await expect(joined).resolves.toEqual({ appendSystemContext: "stale" });
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await expect(adapter.beforePromptBuild(event, ctx)).resolves.toEqual({ appendSystemContext: "fresh" });
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("keeps a transitioned turn-tier flight byte-stable and expires its settled checkpoint", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>();
    const transitioned = { mode: "test-mode-a", block: "transition", route_id: "__default__", state_domain: "quarantine", transitioned: true, audit: [] };
    const fresh = { ...transitioned, block: "fresh", transitioned: false };
    const fakeCore = core({ turn: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(fresh) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const cachePut = vi.spyOn(adapter as any, "cachePut");
    const event = { prompt: "/persona test-mode-a", messages: [] };
    const ctx = { runId: "turn-only" };

    const first = adapter.beforePromptBuild(event, ctx);
    const joined = adapter.beforePromptBuild(event, ctx);
    pending.resolve(transitioned);
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { appendSystemContext: "transition" },
      { appendSystemContext: "transition" },
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);
    expect(cachePut).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "turn" })],
      transitioned,
      expect.any(String),
      expect.any(Map),
    );

    await Promise.resolve();
    expect((adapter as any).turnCache.size).toBe(0);
    await expect(adapter.beforePromptBuild(event, ctx)).resolves.toEqual({ appendSystemContext: "fresh" });
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("computes fresh without cache keys when session and run identity are absent", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "anonymous", messages: [] };
    await expect(adapter.beforePromptBuild(event, {})).resolves.toEqual({ appendSystemContext: PRIVATE_BLOCK });
    await expect(adapter.beforePromptBuild(event, {})).resolves.toEqual({ appendSystemContext: PRIVATE_BLOCK });
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("uses a stable fingerprint when prepared messages cannot be serialized", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const circular: unknown[] = [];
    circular.push(circular);
    const event = { prompt: "circular", messages: circular };
    const ctx = { sessionId: "circular-session", sessionKey: "agent:main:voice-owner" };
    await expect(Promise.all([
      adapter.beforePromptBuild(event, ctx),
      adapter.beforePromptBuild(event, ctx),
    ])).resolves.toEqual([
      { appendSystemContext: PRIVATE_BLOCK },
      { appendSystemContext: PRIVATE_BLOCK },
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);
  });

  it("calls turn again for separate runIds", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    await adapter.beforePromptBuild({ prompt: "one", messages: [] }, { runId: "one", sessionKey: "agent:main:voice-owner" });
    await adapter.beforePromptBuild({ prompt: "two", messages: [] }, { runId: "two", sessionKey: "agent:main:voice-owner" });
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("invalidates the session tier after transition and evaluates the next trigger", async () => {
    const first = { mode: "test-mode-a", block: "first", route_id: "voice-private", state_domain: "private", transitioned: true, audit: [] };
    const second = { mode: "test-mode-b", block: "second", route_id: "voice-private", state_domain: "private", transitioned: true, audit: [] };
    const fakeCore = core({ turn: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const ctx = { runId: "reused-run", sessionId: "same-session", sessionKey: "agent:main:voice-owner" };
    await expect(adapter.beforePromptBuild({ prompt: "/persona test-mode-a", messages: [] }, ctx)).resolves.toEqual({ appendSystemContext: "first" });
    await expect(adapter.beforePromptBuild({ prompt: "/persona test-mode-b", messages: [] }, ctx)).resolves.toEqual({ appendSystemContext: "second" });
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("does not replay a transitioned result for an identical later delivery", async () => {
    const fakeCore = core({
      turn: vi.fn()
        .mockResolvedValueOnce({ mode: "test-mode-a", block: "first", route_id: "voice-private", state_domain: "private", transitioned: true, audit: [] })
        .mockResolvedValueOnce({ mode: "test-mode-a", block: "second", route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] }),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "/persona test-mode-a", messages: [] };
    const ctx = { runId: "reused-run", sessionId: "same-session", sessionKey: "agent:main:voice-owner" };
    await expect(adapter.beforePromptBuild(event, ctx)).resolves.toEqual({ appendSystemContext: "first" });
    await expect(adapter.beforePromptBuild(event, ctx)).resolves.toEqual({ appendSystemContext: "second" });
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-flight session resolution outside completed-cache eviction", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>();
    const fakeCore = core({
      turn: vi.fn((input: { utterance?: string }) => input.utterance === "target"
        ? pending.promise
        : Promise.resolve({ mode: "test-mode-a", block: PRIVATE_BLOCK, route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] })),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "target", messages: [] };
    const targetCtx = { sessionId: "target-session", sessionKey: "agent:main:voice-owner" };
    const first = adapter.beforePromptBuild(event, targetCtx);
    await Promise.all(Array.from({ length: 257 }, (_, index) => adapter.beforePromptBuild(
      { prompt: `pressure-${index}`, messages: [] },
      { sessionId: `pressure-${index}`, sessionKey: "agent:main:voice-owner" },
    )));
    const duplicate = adapter.beforePromptBuild(event, targetCtx);
    expect(fakeCore.turn).toHaveBeenCalledTimes(258);
    pending.resolve({ mode: "test-mode-a", block: PRIVATE_BLOCK, route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { appendSystemContext: PRIVATE_BLOCK },
      { appendSystemContext: PRIVATE_BLOCK },
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(258);
  });

  it("joins an existing flight even when resolution bookkeeping is at capacity", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>();
    const fakeCore = core({ turn: vi.fn(() => pending.promise) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "at capacity", messages: [] };
    const ctx = { sessionId: "capacity-session", sessionKey: "agent:main:voice-owner" };
    const first = adapter.beforePromptBuild(event, ctx);
    const tracking = adapter as any;
    const placeholder = Promise.resolve({
      mode: "test-mode-a",
      block: "placeholder",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    for (let index = 0; index < 511; index += 1) {
      tracking.resolutionFlights.set(`occupied-${index}`, placeholder);
    }
    expect(tracking.resolutionFlights.size).toBe(512);

    const joined = adapter.beforePromptBuild(event, ctx);
    await Promise.resolve();
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);
    pending.resolve({
      mode: "test-mode-a",
      block: "at-capacity",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { appendSystemContext: "at-capacity" },
      { appendSystemContext: "at-capacity" },
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);
  });

  it("fails closed and reports flight_limit for a new key at resolution capacity", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const tracking = adapter as any;
    const placeholder = Promise.resolve({
      mode: "test-mode-a",
      block: "placeholder",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    for (let index = 0; index < 512; index += 1) {
      tracking.resolutionFlights.set(`occupied-${index}`, placeholder);
    }

    await expect(adapter.beforePromptBuild(
      { prompt: "new at capacity", messages: [] },
      { sessionId: "new-capacity-session", sessionKey: "agent:main:voice-owner" },
    )).resolves.toBeUndefined();
    expect(fakeCore.turn).not.toHaveBeenCalled();
    const [reportedError, reportContext] = fakeCore.reportAdapterError.mock.calls[0]!;
    expect(reportedError).toEqual(expect.objectContaining({ name: "flight_limit" }));
    expect(reportContext).not.toHaveProperty("category");
  });

  it("persists flight_limit through the real core reporter at resolution capacity", async () => {
    const installRoot = fixture();
    const adapter = new OpenClawAdapter(installRoot, vi.fn());
    const tracking = adapter as any;
    const placeholder = Promise.resolve({
      mode: "test-mode-a",
      block: "placeholder",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    for (let index = 0; index < 512; index += 1) {
      tracking.resolutionFlights.set(`occupied-${index}`, placeholder);
    }

    await expect(adapter.beforePromptBuild(
      { prompt: "real audit at capacity", messages: [] },
      { sessionId: "real-audit-capacity", sessionKey: "agent:main:voice-owner" },
    )).resolves.toBeUndefined();

    const auditLines = readFileSync(join(installRoot, "audit", "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { reason?: string });
    expect(auditLines.at(-1)?.reason).toBe("flight_limit");
  });

  it("resumes normal single-flight resolution after capacity becomes available", async () => {
    const occupying = deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>();
    const recovered = deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>();
    const fakeCore = core({
      turn: vi.fn((input: { utterance?: string }) => input.utterance === "occupying"
        ? occupying.promise
        : recovered.promise),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const occupyingCall = adapter.beforePromptBuild(
      { prompt: "occupying", messages: [] },
      { sessionId: "occupying-session", sessionKey: "agent:main:voice-owner" },
    );
    const tracking = adapter as any;
    const placeholder = Promise.resolve({
      mode: "test-mode-a",
      block: "placeholder",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    for (let index = 0; index < 511; index += 1) {
      tracking.resolutionFlights.set(`occupied-${index}`, placeholder);
    }
    await expect(adapter.beforePromptBuild(
      { prompt: "blocked", messages: [] },
      { sessionId: "blocked-session", sessionKey: "agent:main:voice-owner" },
    )).resolves.toBeUndefined();
    await Promise.resolve();
    expect(fakeCore.turn).toHaveBeenCalledTimes(1);

    occupying.resolve({
      mode: "test-mode-a",
      block: "occupying",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    await expect(occupyingCall).resolves.toEqual({ appendSystemContext: "occupying" });
    expect(tracking.resolutionFlights.size).toBe(511);

    const event = { prompt: "recovered", messages: [] };
    const ctx = { sessionId: "recovered-session", sessionKey: "agent:main:voice-owner" };
    const first = adapter.beforePromptBuild(event, ctx);
    const joined = adapter.beforePromptBuild(event, ctx);
    await Promise.resolve();
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
    recovered.resolve({
      mode: "test-mode-a",
      block: "recovered",
      route_id: "voice-private",
      state_domain: "private",
      transitioned: false,
      audit: [],
    });
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { appendSystemContext: "recovered" },
      { appendSystemContext: "recovered" },
    ]);
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
  });

  it("bounds bookkeeping for more than the admitted number of stalled flights", async () => {
    const stalled = new Promise<never>(() => {});
    const fakeCore = core({ turn: vi.fn(() => stalled) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    for (let index = 0; index < 600; index += 1) {
      void adapter.beforePromptBuild(
        { prompt: `stalled-${index}`, messages: [] },
        { sessionId: `stalled-${index}`, sessionKey: "agent:main:voice-owner" },
      );
    }
    await Promise.resolve();

    const tracking = adapter as any;
    expect(tracking.resolutionFlights.size).toBe(512);
    expect(tracking.inflightKeys.size).toBeLessThanOrEqual(512);
    expect(tracking.cacheGenerations.size).toBeLessThanOrEqual(512);
    expect([...tracking.domainKeys.values()].reduce((sum: number, keys: Set<string>) => sum + keys.size, 0)).toBeLessThanOrEqual(512);
  });

  it("cleans all admitted-flight bookkeeping after success", async () => {
    const pending = Array.from({ length: 20 }, () => deferred<Awaited<ReturnType<ReturnType<typeof core>["turn"]>>>());
    let next = 0;
    const fakeCore = core({ turn: vi.fn(() => pending[next++]!.promise) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const calls = pending.map((_, index) => adapter.beforePromptBuild(
      { prompt: `cleanup-${index}`, messages: [] },
      { sessionId: `cleanup-${index}`, sessionKey: "agent:main:voice-owner" },
    ));
    await Promise.resolve();
    for (const flight of pending) {
      flight.resolve({ mode: "test-mode-a", block: PRIVATE_BLOCK, route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] });
    }
    await Promise.all(calls);
    await Promise.resolve();

    const tracking = adapter as any;
    expect(tracking.resolutionFlights.size).toBe(0);
    expect(tracking.inflightKeys.size).toBe(0);
    expect(tracking.cacheGenerations.size).toBe(0);
    expect(tracking.domainKeys.size).toBe(0);
  });

  it("fails closed and reports a hook exception", async () => {
    const failure = new Error("boom");
    const fakeCore = core({ turn: vi.fn(async () => { throw failure; }) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    await expect(adapter.beforePromptBuild(
      { prompt: "hello", messages: [] },
      { runId: "broken", sessionKey: "agent:main:voice-owner" },
    )).resolves.toBeUndefined();
    expect(fakeCore.reportAdapterError).toHaveBeenCalledTimes(1);
  });

  it("contains throwing context getters across hook and tool factory callbacks", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const ctx = {} as { sessionKey?: string };
    Object.defineProperty(ctx, "sessionKey", { get() { throw new Error("boom"); } });

    await expect(adapter.beforePromptBuild({ prompt: "hello", messages: [] }, ctx)).resolves.toBeUndefined();
    expect(adapter.toolFactory(ctx)).toBeNull();
    await vi.waitFor(() => expect(fakeCore.reportAdapterError).toHaveBeenCalledTimes(2));
    expect(fakeCore.turn).not.toHaveBeenCalled();
    expect(fakeCore.set).not.toHaveBeenCalled();
  });

  it("releases a failed single-flight so the same request can retry", async () => {
    const failure = new Error("boom");
    const fakeCore = core({
      turn: vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ mode: "test-mode-a", block: PRIVATE_BLOCK, route_id: "voice-private", state_domain: "private", transitioned: false, audit: [] }),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const event = { prompt: "hello", messages: [] };
    const ctx = { sessionId: "retry-session", sessionKey: "agent:main:voice-owner" };
    await expect(adapter.beforePromptBuild(event, ctx)).resolves.toBeUndefined();
    await expect(adapter.beforePromptBuild(event, ctx)).resolves.toEqual({ appendSystemContext: PRIVATE_BLOCK });
    await Promise.resolve();
    expect(fakeCore.turn).toHaveBeenCalledTimes(2);
    expect((adapter as any).resolutionFlights.size).toBe(0);
    expect((adapter as any).inflightKeys.size).toBe(0);
  });

  it("reports with degraded context when route resolution itself fails", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    vi.spyOn(adapter as any, "resolution").mockImplementation(() => { throw new Error("resolution failed"); });
    await expect(adapter.beforePromptBuild(
      { prompt: "hello", messages: [] },
      { runId: "broken", sessionKey: "agent:main:voice-owner" },
    )).resolves.toBeUndefined();
    expect(fakeCore.reportAdapterError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      installRoot: adapter.installRoot,
      turn_key: "broken",
    }));
  });

  it("contains reporter and host-warning failures", async () => {
    const fakeCore = core({ reportAdapterError: vi.fn(async () => { throw new Error("report failed"); }) });
    const adapter = new OpenClawAdapter(fixture(), () => { throw new Error("warn failed"); }, fakeCore);
    vi.spyOn(adapter as any, "resolution").mockImplementation(() => { throw new Error("resolution failed"); });
    await expect(adapter.beforePromptBuild(
      { prompt: "hello", messages: [] },
      { sessionKey: "agent:main:voice-owner" },
    )).resolves.toBeUndefined();
  });

  it("returns a tool only for an explicit-and-agent route", async () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const tool = adapter.toolFactory({ sessionKey: "agent:main:voice-owner", senderIsOwner: true });
    expect(tool?.name).toBe("persona_set");
    expect(tool?.label).toBe("Set Persona Mode");
    expect(tool?.parameters).toEqual(PERSONA_SET_PARAMETERS);
    expect(adapter.toolFactory({ sessionKey: "agent:main:voice-owner" })).toBeNull();
    expect(adapter.toolFactory({ sessionKey: "agent:main:voice-owner", senderIsOwner: false })).toBeNull();
    expect(adapter.toolFactory({ sessionKey: "agent:main:public" })).toBeNull();
    expect(adapter.toolFactory({ sessionKey: "explicit:voice-owner" })).toBeNull();
    const result = await tool?.execute("call-1", { mode: "test-mode-a" });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true, mode: "test-mode-a", transitioned: true, audit: [] }) }],
      details: { ok: true, mode: "test-mode-a", transitioned: true, audit: [] },
    });
    expect(fakeCore.set).toHaveBeenCalledWith({
      actor: "agent",
      ctx: { session_key_rest: "voice-owner" },
      requested_mode: "test-mode-a",
    }, expect.anything());
  });

  it("reports and throws tool execution failures per the SDK contract", async () => {
    const failure = new Error("set failed");
    const fakeCore = core({ set: vi.fn(async () => { throw failure; }) });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const tool = adapter.toolFactory({ sessionKey: "agent:main:voice-owner", senderIsOwner: true });
    await expect(tool?.execute("call-1", { mode: "test-mode-a" })).rejects.toBe(failure);
    expect(fakeCore.reportAdapterError).toHaveBeenCalledTimes(1);
  });

  it("throws a fixed redacted message for policy-rejected tool execution", async () => {
    const fakeCore = core({
      set: vi.fn(async () => ({
        ok: false,
        mode: "sensitive-current-mode",
        transitioned: false,
        rejected: { requested_mode: "sensitive-requested-mode", reason: "sensitive-policy-detail" },
        audit: [],
      })),
    });
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const tool = adapter.toolFactory({ sessionKey: "agent:main:voice-owner", senderIsOwner: true });
    await expect(tool?.execute("call-1", { mode: "sensitive-requested-mode" }))
      .rejects.toThrow("persona_set rejected: mode not allowed on this route");
    expect(fakeCore.reportAdapterError).toHaveBeenCalledTimes(1);
  });

  it("validates persona_set mode in both its schema and execute handler", async () => {
    expect(PERSONA_SET_PARAMETERS.properties.mode).toMatchObject({
      pattern: "^[a-z0-9-]+$",
      maxLength: 64,
    });
    const fakeCore = core();
    const adapter = new OpenClawAdapter(fixture(), vi.fn(), fakeCore);
    const tool = adapter.toolFactory({ sessionKey: "agent:main:voice-owner", senderIsOwner: true });
    expect(tool).not.toBeNull();
    for (const mode of ["Uppercase", "has space", "a".repeat(65)]) {
      await expect(tool!.execute("invalid", { mode })).rejects.toThrow(
        "persona_set rejected: mode not allowed on this route",
      );
    }
    expect(fakeCore.set).not.toHaveBeenCalled();
    expect(fakeCore.reportAdapterError).toHaveBeenCalledTimes(3);
  });

  it("fails closed and reports factory resolution errors", () => {
    const fakeCore = core();
    const adapter = new OpenClawAdapter("\0invalid", vi.fn(), fakeCore);
    expect(adapter.toolFactory({ sessionKey: "agent:main:voice-owner" })).toBeNull();
  });

  it("prefers native plugin config and registers only the declared surfaces", () => {
    const on = vi.fn();
    const registerTool = vi.fn();
    const api = {
      pluginConfig: { installRoot: fixture() },
      logger: { warn: vi.fn() },
      on,
      registerTool,
    } as unknown as OpenClawPluginApi;
    expect(registerAdapter(api)?.installRoot).toBe(api.pluginConfig?.installRoot);
    expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), { name: "persona_set" });
  });

  it("contains a host logger failure when configuration is absent", () => {
    vi.stubEnv("PERSONA_ENGINE_INSTALL_ROOT", "");
    try {
      const api = {
        logger: { warn: vi.fn(() => { throw new Error("warn failed"); }) },
        on: vi.fn(),
        registerTool: vi.fn(),
      } as unknown as OpenClawPluginApi;
      expect(registerAdapter(api)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
