import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptStateTransition,
  compareAndSwapState,
  readState,
} from "../../src/state/index.js";
import type { CasInput, StateSnapshot } from "../../src/state/index.js";
import type { StateFile } from "../../src/types.js";

const temporaryRoots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "persona-engine-state-"));
  temporaryRoots.push(root);
  return root;
}

function storedState(overrides: Partial<StateFile> = {}): StateFile {
  return {
    v: 1,
    revision: 1,
    mode: "focus",
    set_by: "owner",
    set_at: "1970-01-01T00:00:00.000Z",
    route_id: "private-route",
    ...overrides,
  };
}

function casInput(root: string, overrides: Partial<CasInput> = {}): CasInput {
  return {
    stateRoot: root,
    domain: "shared",
    expectedRevision: 0,
    mode: "focus",
    setBy: "owner",
    routeId: "private-route",
    ...overrides,
  };
}

async function writeState(root: string, state: StateFile): Promise<void> {
  await writeFile(join(root, "shared.json"), `${JSON.stringify(state)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("state reads and atomic writes", () => {
  it("returns the exact implicit initial shape when the state file is absent", async () => {
    const root = await stateRoot();

    await expect(readState(root, "shared", "private-route")).resolves.toEqual({
      ok: true,
      state: { v: 1, revision: 0, mode: "public" },
      exists: false,
      audit: [],
    });
  });

  it("atomically creates revision 1 from the implicit state", async () => {
    const root = await stateRoot();
    const result = await compareAndSwapState(casInput(root));

    expect(result).toMatchObject({
      status: "applied",
      previous: { v: 1, revision: 0, mode: "public" },
      state: {
        v: 1,
        revision: 1,
        mode: "focus",
        set_by: "owner",
        route_id: "private-route",
      },
    });
    if (result.status !== "applied") {
      throw new Error("expected applied CAS");
    }
    expect(Number.isNaN(Date.parse(result.state.set_at))).toBe(false);

    const onDisk = JSON.parse(
      await readFile(join(root, "shared.json"), "utf8"),
    ) as StateFile;
    expect(onDisk).toEqual(result.state);
    expect(await readdir(root)).toEqual(["shared.json"]);
  });

  it.each(["UPPER", "a/b"])(
    "treats invalid domain %s as F2 without writing",
    async (domain) => {
      const root = await stateRoot();

      await expect(readState(root, domain, "private-route")).resolves.toMatchObject({
        ok: false,
        state: { v: 1, revision: 0, mode: "public" },
        audit: [{ event: "state_error", domain }],
      });
      await expect(
        compareAndSwapState(casInput(root, { domain })),
      ).resolves.toMatchObject({
        status: "state_error",
        state: { v: 1, revision: 0, mode: "public" },
        audit: [{ event: "state_error", domain }],
      });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("treats corrupt JSON as F2 and refuses to overwrite it", async () => {
    const root = await stateRoot();
    await writeFile(join(root, "shared.json"), "{not-json", "utf8");

    const read = await readState(root, "shared", "private-route");
    expect(read).toMatchObject({
      ok: false,
      state: { v: 1, revision: 0, mode: "public" },
      audit: [{ event: "state_error", route_id: "private-route", domain: "shared" }],
    });

    const transition = await compareAndSwapState(casInput(root));
    expect(transition).toMatchObject({
      status: "state_error",
      state: { mode: "public" },
      audit: [{ event: "state_error" }],
    });
    expect(await readFile(join(root, "shared.json"), "utf8")).toBe("{not-json");
  });

  it("reads a state revision at Number.MAX_SAFE_INTEGER", async () => {
    const root = await stateRoot();
    await writeState(
      root,
      storedState({ revision: Number.MAX_SAFE_INTEGER }),
    );

    await expect(readState(root, "shared", "private-route")).resolves.toMatchObject({
      ok: true,
      state: { revision: Number.MAX_SAFE_INTEGER },
      audit: [],
    });
  });

  it("treats a state revision one past Number.MAX_SAFE_INTEGER as F2", async () => {
    const root = await stateRoot();
    await writeState(root, storedState({ revision: 9_007_199_254_740_992 }));

    await expect(readState(root, "shared", "private-route")).resolves.toMatchObject({
      ok: false,
      state: { revision: 0, mode: "public" },
      audit: [{ event: "state_error" }],
    });
  });

  it("refuses CAS at Number.MAX_SAFE_INTEGER instead of writing an unsafe revision", async () => {
    const root = await stateRoot();
    const existing = storedState({ revision: Number.MAX_SAFE_INTEGER });
    await writeState(root, existing);

    const result = await compareAndSwapState(
      casInput(root, { expectedRevision: Number.MAX_SAFE_INTEGER }),
    );
    expect(result).toMatchObject({
      status: "state_error",
      audit: [{ event: "state_error" }],
    });
    const onDisk = JSON.parse(await readFile(join(root, "shared.json"), "utf8"));
    expect(onDisk.revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects an unsafe expected revision before touching state files", async () => {
    const root = await stateRoot();
    const existing = storedState();
    await writeState(root, existing);

    const result = await compareAndSwapState(
      casInput(root, { expectedRevision: 9_007_199_254_740_992 }),
    );

    expect(result).toMatchObject({
      status: "state_error",
      state: { revision: 0, mode: "public" },
      audit: [{ event: "state_error" }],
    });
    expect(await readdir(root)).toEqual(["shared.json"]);
    expect(JSON.parse(await readFile(join(root, "shared.json"), "utf8"))).toEqual(
      existing,
    );
  });

  it("treats an invalid set_at timestamp as F2 and refuses to overwrite it", async () => {
    const root = await stateRoot();
    const invalid = storedState({ set_at: "not-a-date" });
    await writeState(root, invalid);

    const result = await compareAndSwapState(
      casInput(root, { expectedRevision: invalid.revision }),
    );

    expect(result).toMatchObject({
      status: "state_error",
      state: { mode: "public" },
      audit: [{ event: "state_error" }],
    });
    expect(JSON.parse(await readFile(join(root, "shared.json"), "utf8"))).toEqual(
      invalid,
    );
  });

  it.each([
    "2021-02-29T00:00:00.000Z",
    "2021-02-28 10:00:00",
  ])("treats non-canonical set_at %s as F2", async (setAt) => {
    const root = await stateRoot();
    await writeState(root, storedState({ set_at: setAt }));

    await expect(readState(root, "shared", "private-route")).resolves.toMatchObject({
      ok: false,
      state: { mode: "public" },
      audit: [{ event: "state_error" }],
    });
  });

  it("accepts a canonical leap-day set_at timestamp", async () => {
    const root = await stateRoot();
    const leapDay = "2024-02-29T00:00:00.000Z";
    await writeState(root, storedState({ set_at: leapDay }));

    await expect(readState(root, "shared", "private-route")).resolves.toMatchObject({
      ok: true,
      state: { set_at: leapDay },
      audit: [],
    });
  });

  it.each([
    ["an array", [1, 2]],
    ["a bare string", "str"],
  ])("treats %s state document as F2", async (_case, invalid) => {
    const root = await stateRoot();
    const contents = JSON.stringify(invalid);
    await writeFile(join(root, "shared.json"), contents, "utf8");

    const result = await compareAndSwapState(casInput(root));

    expect(result).toMatchObject({
      status: "state_error",
      state: { mode: "public" },
      audit: [{ event: "state_error" }],
    });
    expect(await readFile(join(root, "shared.json"), "utf8")).toBe(contents);
  });

  it.each([
    ["an invalid set_by", { ...storedState(), set_by: "nobody" }],
    [
      "a missing route_id",
      Object.fromEntries(
        Object.entries(storedState()).filter(([key]) => key !== "route_id"),
      ),
    ],
  ])("treats state with %s as F2", async (_case, invalid) => {
    const root = await stateRoot();
    await writeFile(
      join(root, "shared.json"),
      `${JSON.stringify(invalid)}\n`,
      "utf8",
    );

    const result = await compareAndSwapState(
      casInput(root, { expectedRevision: 1 }),
    );

    expect(result).toMatchObject({
      status: "state_error",
      state: { mode: "public" },
      audit: [{ event: "state_error" }],
    });
    expect(JSON.parse(await readFile(join(root, "shared.json"), "utf8"))).toEqual(
      invalid,
    );
  });

  it("upgrades a readable v0 snapshot to v1 on a successful transition", async () => {
    const root = await stateRoot();
    const legacy = { v: 0, revision: 3, mode: "focus" };
    await writeFile(
      join(root, "shared.json"),
      `${JSON.stringify(legacy)}\n`,
      "utf8",
    );

    const result = await compareAndSwapState(
      casInput(root, { expectedRevision: 3, mode: "quiet" }),
    );

    expect(result).toMatchObject({
      status: "applied",
      previous: legacy,
      state: { v: 1, revision: 4, mode: "quiet" },
    });
    expect(JSON.parse(await readFile(join(root, "shared.json"), "utf8"))).toMatchObject({
      v: 1,
      revision: 4,
      mode: "quiet",
      set_by: "owner",
      route_id: "private-route",
    });
  });

  it("treats a newer state version as F2 and refuses to write", async () => {
    const root = await stateRoot();
    const future = storedState({ v: 2 });
    await writeState(root, future);

    const result = await compareAndSwapState(
      casInput(root, { expectedRevision: future.revision }),
    );
    expect(result).toMatchObject({
      status: "state_error",
      state: { mode: "public" },
      audit: [{ event: "state_error" }],
    });
    expect(JSON.parse(await readFile(join(root, "shared.json"), "utf8"))).toEqual(future);
  });
});

describe("exclusive lock protocol", () => {
  it("does not unlink a lock whose token was replaced before release", async () => {
    const root = await stateRoot();
    const lockPath = join(root, "shared.lock");
    const foreignToken = "replacement-owner";
    let nowCalls = 0;

    const result = await compareAndSwapState(casInput(root), {
      now: () => {
        nowCalls += 1;
        if (nowCalls === 2) {
          writeFileSync(lockPath, foreignToken, "utf8");
        }
        return new Date("1970-01-01T00:00:00.000Z");
      },
    });

    expect(result.status).toBe("applied");
    expect(await readFile(lockPath, "utf8")).toBe(foreignToken);
  });

  it(
    "times out after two seconds on a fresh in-flight lock and emits F2",
    async () => {
      const root = await stateRoot();
      await writeFile(join(root, "shared.lock"), "other-owner", "utf8");
      const startedAt = Date.now();

      const result = await compareAndSwapState(casInput(root));
      const elapsed = Date.now() - startedAt;

      expect(result).toMatchObject({
        status: "state_error",
        state: { mode: "public" },
        audit: [{ event: "state_error" }],
      });
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(3_500);
      expect(await readFile(join(root, "shared.lock"), "utf8")).toBe("other-owner");
    },
    6_000,
  );

  it("recovers a lock older than the documented five-second threshold", async () => {
    const root = await stateRoot();
    const lockPath = join(root, "shared.lock");
    await writeFile(lockPath, "crashed-owner", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const result = await compareAndSwapState(casInput(root));

    expect(result.status).toBe("applied");
    expect(await readdir(root)).toEqual(["shared.json"]);
  });

  it("recovers a stale recovery file left by a crashed reaper", async () => {
    const root = await stateRoot();
    const lockPath = join(root, "shared.lock");
    const recoveryPath = `${lockPath}.recovery`;
    await writeFile(lockPath, "crashed-owner", "utf8");
    await writeFile(recoveryPath, "", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    await utimes(recoveryPath, old, old);

    const result = await compareAndSwapState(casInput(root));

    expect(result.status).toBe("applied");
    expect(await readdir(root)).toEqual(["shared.json"]);
  });

  it("serializes concurrent reclaimers of the same stale lock", async () => {
    const root = await stateRoot();
    const lockPath = join(root, "shared.lock");
    await writeFile(lockPath, "crashed-owner", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, writer) =>
        compareAndSwapState(casInput(root, { mode: `recovered-${writer}` })),
      ),
    );

    expect(results.filter(({ status }) => status === "applied")).toHaveLength(1);
    expect(
      results.filter(({ status }) => status === "revision_mismatch"),
    ).toHaveLength(7);
    expect(await readdir(root)).toEqual(["shared.json"]);
  });
});

describe("revision CAS and retry-once semantics", () => {
  it("returns the fresh on-disk snapshot on a single CAS mismatch", async () => {
    const root = await stateRoot();
    await writeState(root, storedState());

    const result = await compareAndSwapState(casInput(root));

    expect(result).toEqual({
      status: "revision_mismatch",
      state: storedState(),
      audit: [],
    });
  });

  it("re-evaluates once against fresh state and applies one retry", async () => {
    const root = await stateRoot();
    await writeState(root, storedState());
    const seen: StateSnapshot[] = [];

    const result = await attemptStateTransition(
      casInput(root, { mode: "quiet" }),
      (freshState) => {
        seen.push(freshState);
        return { allowed: true };
      },
    );

    expect(seen).toEqual([storedState()]);
    expect(result).toMatchObject({
      status: "applied",
      mode: "quiet",
      transitioned: true,
      state: { revision: 2, mode: "quiet" },
    });
  });

  it("rejects with the second fresh mode when the sole retry also conflicts", async () => {
    const root = await stateRoot();
    await writeState(root, storedState());

    const result = await attemptStateTransition(
      casInput(root, { mode: "quiet" }),
      async (freshState) => {
        const competing = await compareAndSwapState(
          casInput(root, {
            expectedRevision: freshState.revision,
            mode: "sealed",
            setBy: "agent",
          }),
        );
        expect(competing.status).toBe("applied");
        return { allowed: true };
      },
    );

    expect(result).toMatchObject({
      status: "rejected",
      mode: "sealed",
      transitioned: false,
      state: { revision: 2, mode: "sealed" },
      rejected: {
        requested_mode: "quiet",
        reason: "state revision changed during the single transition retry",
      },
      audit: [{ event: "switch_rejected", from: "sealed" }],
    });
  });

  it("rejects immediately when re-authorization fails on the fresh snapshot", async () => {
    const root = await stateRoot();
    await writeState(root, storedState());

    const result = await attemptStateTransition(
      casInput(root, { mode: "quiet" }),
      () => ({ allowed: false, reason: "fresh route policy denied the target" }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      mode: "focus",
      transitioned: false,
      rejected: {
        requested_mode: "quiet",
        reason: "fresh route policy denied the target",
      },
    });
  });

  it(
    "allows exactly one same-revision writer per round with no lost updates",
    async () => {
      const root = await stateRoot();
      const writerCount = 8;
      const rounds = 5;
      let appliedCount = 0;

      for (let revision = 0; revision < rounds; revision += 1) {
        const results = await Promise.all(
          Array.from({ length: writerCount }, (_, writer) =>
            compareAndSwapState(
              casInput(root, {
                expectedRevision: revision,
                mode: `dummy-${revision}-${writer}`,
                setBy: "agent",
              }),
            ),
          ),
        );
        const applied = results.filter(({ status }) => status === "applied");
        const conflicts = results.filter(
          ({ status }) => status === "revision_mismatch",
        );

        expect(applied).toHaveLength(1);
        expect(conflicts).toHaveLength(writerCount - 1);
        appliedCount += applied.length;
      }

      const final = await readState(root, "shared", "private-route");
      expect(final).toMatchObject({
        ok: true,
        state: { revision: appliedCount },
      });
      expect(appliedCount).toBe(rounds);
    },
    10_000,
  );
});
