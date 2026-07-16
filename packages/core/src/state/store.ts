import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { AuditEvent, Rejected, StateFile } from "../types.js";

export const STATE_VERSION = 1;
export const LOCK_TIMEOUT_MS = 2_000;
// Locks should cover only a read plus one fsync/rename. Five seconds leaves
// headroom for slow disks while still recovering promptly from crashed writers.
export const STALE_LOCK_MS = 5_000;

const LOCK_RETRY_MS = 20;
const DOMAIN_PATTERN = /^[a-z0-9_-]{1,64}$/;

export type StateSnapshot = Pick<StateFile, "v" | "revision" | "mode"> &
  Partial<Pick<StateFile, "set_by" | "set_at" | "route_id">>;

export type StateReadResult =
  | { ok: true; state: StateSnapshot; exists: boolean; audit: [] }
  | { ok: false; state: StateSnapshot; exists: boolean; audit: AuditEvent[] };

export type CasInput = {
  stateRoot: string;
  domain: string;
  expectedRevision: number;
  mode: string;
  setBy: StateFile["set_by"];
  routeId: string;
};

export type CasResult =
  | {
      status: "applied";
      state: StateFile;
      previous: StateSnapshot;
      audit: AuditEvent[];
    }
  | { status: "revision_mismatch"; state: StateSnapshot; audit: [] }
  | { status: "state_error"; state: StateSnapshot; audit: AuditEvent[] };

export type Reevaluation =
  | { allowed: true }
  | { allowed: false; reason: string };

export type TransitionAttemptResult =
  | {
      status: "applied";
      mode: string;
      transitioned: true;
      state: StateFile;
      audit: AuditEvent[];
    }
  | {
      status: "rejected";
      mode: string;
      transitioned: false;
      state: StateSnapshot;
      rejected: Rejected;
      audit: AuditEvent[];
    }
  | {
      status: "state_error";
      mode: "public";
      transitioned: false;
      state: StateSnapshot;
      audit: AuditEvent[];
    };

type DiskRead =
  | { ok: true; state: StateSnapshot; exists: boolean }
  | { ok: false; state: StateSnapshot; exists: boolean; reason: string };

type HeldLock = { handle: Awaited<ReturnType<typeof open>>; token: string };

type StoreOptions = {
  now?: () => Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

type StaleRecoveryResult = "recovered" | "busy" | { error: string };

function initialState(): StateSnapshot {
  return { v: STATE_VERSION, revision: 0, mode: "public" };
}

function paths(stateRoot: string, domain: string): {
  state: string;
  temporary: string;
  lock: string;
} {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`invalid state domain: ${domain}`);
  }

  const state = join(stateRoot, `${domain}.json`);
  return {
    state,
    temporary: `${state}.tmp`,
    lock: join(stateRoot, `${domain}.lock`),
  };
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function validSetBy(value: unknown): value is StateFile["set_by"] {
  return value === "owner" || value === "agent" || value === "admin";
}

function isCanonicalIso8601(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseState(contents: string): StateSnapshot {
  const value = JSON.parse(contents) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("state file must contain a JSON object");
  }

  const state = value as Record<string, unknown>;
  if (!Number.isInteger(state.v) || (state.v as number) < 0) {
    throw new Error("state version must be a non-negative integer");
  }
  if ((state.v as number) > STATE_VERSION) {
    throw new Error(`state version ${String(state.v)} is newer than supported version 1`);
  }
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 0) {
    throw new Error("state revision must be a non-negative integer");
  }
  if (typeof state.mode !== "string") {
    throw new Error("state mode must be a string");
  }

  if (
    state.v === STATE_VERSION &&
    (!validSetBy(state.set_by) ||
      typeof state.set_at !== "string" ||
      !isCanonicalIso8601(state.set_at) ||
      typeof state.route_id !== "string")
  ) {
    throw new Error("state version 1 is missing transition metadata");
  }

  const snapshot: StateSnapshot = {
    v: state.v as number,
    revision: state.revision as number,
    mode: state.mode,
  };
  if (validSetBy(state.set_by)) {
    snapshot.set_by = state.set_by;
  }
  if (typeof state.set_at === "string") {
    snapshot.set_at = state.set_at;
  }
  if (typeof state.route_id === "string") {
    snapshot.route_id = state.route_id;
  }

  return snapshot;
}

async function readDiskState(statePath: string): Promise<DiskRead> {
  let contents: string;
  try {
    contents = await readFile(statePath, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return { ok: true, state: initialState(), exists: false };
    }
    return {
      ok: false,
      state: initialState(),
      exists: false,
      reason: `state read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    return { ok: true, state: parseState(contents), exists: true };
  } catch (error) {
    return {
      ok: false,
      state: initialState(),
      exists: true,
      reason: `state read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function stateErrorAudit(
  timestamp: string,
  routeId: string,
  domain: string,
): AuditEvent[] {
  return [
    {
      ts: timestamp,
      event: "state_error",
      route_id: routeId,
      domain,
    },
  ];
}

export async function readState(
  stateRoot: string,
  domain: string,
  routeId: string,
  options: StoreOptions = {},
): Promise<StateReadResult> {
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  let statePath: string;
  try {
    statePath = paths(stateRoot, domain).state;
  } catch {
    return {
      ok: false,
      state: initialState(),
      exists: false,
      audit: stateErrorAudit(timestamp, routeId, domain),
    };
  }

  const result = await readDiskState(statePath);
  if (result.ok) {
    return { ...result, audit: [] };
  }

  return {
    ok: false,
    state: result.state,
    exists: result.exists,
    audit: stateErrorAudit(timestamp, routeId, domain),
  };
}

async function acquireLock(
  lockPath: string,
  options: StoreOptions,
): Promise<HeldLock | string> {
  const timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        return `lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (handle !== undefined) {
      const token = randomUUID();
      try {
        await handle.writeFile(token, "utf8");
        await handle.sync();
        return { handle, token };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        return `lock initialization failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > staleLockMs) {
        const recovery = await recoverStaleLock(lockPath, staleLockMs);
        if (typeof recovery === "object") {
          return recovery.error;
        }
        if (recovery === "busy") {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            return `lock timeout after ${timeoutMs}ms`;
          }
          await delay(Math.min(LOCK_RETRY_MS, remainingMs));
        }
        continue;
      }
    } catch (error) {
      if (errno(error) === "ENOENT") {
        continue;
      }
      return `lock inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return `lock timeout after ${timeoutMs}ms`;
    }
    await delay(Math.min(LOCK_RETRY_MS, remainingMs));
  }
}

async function recoverStaleLock(
  lockPath: string,
  staleLockMs: number,
): Promise<StaleRecoveryResult> {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryHandle: Awaited<ReturnType<typeof open>>;

  try {
    // This second O_EXCL file serializes stale reapers. Without it, two
    // processes can stat the same stale lock and the later unlink can remove
    // the earlier process's newly acquired lock.
    recoveryHandle = await open(recoveryPath, "wx");
  } catch (error) {
    if (errno(error) !== "EEXIST") {
      return {
        error: `stale lock recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const recoveryStat = await stat(recoveryPath);
      if (Date.now() - recoveryStat.mtimeMs <= staleLockMs) {
        return "busy";
      }
      await unlink(recoveryPath);
      recoveryHandle = await open(recoveryPath, "wx");
    } catch (retryError) {
      if (errno(retryError) === "EEXIST" || errno(retryError) === "ENOENT") {
        return "busy";
      }
      return {
        error: `stale lock recovery failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      };
    }
  }

  try {
    try {
      const freshStat = await stat(lockPath);
      if (Date.now() - freshStat.mtimeMs > staleLockMs) {
        await unlink(lockPath);
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") {
        return {
          error: `stale lock removal failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return "recovered";
  } finally {
    await recoveryHandle.close().catch(() => undefined);
    await unlink(recoveryPath).catch(() => undefined);
  }
}

async function releaseLock(lockPath: string, lock: HeldLock): Promise<void> {
  await lock.handle.close();

  try {
    const currentToken = await readFile(lockPath, "utf8");
    if (currentToken === lock.token) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (errno(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function atomicWriteState(
  statePath: string,
  temporaryPath: string,
  state: StateFile,
): Promise<void> {
  const handle = await open(temporaryPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporaryPath, statePath);
}

export async function compareAndSwapState(
  input: CasInput,
  options: StoreOptions = {},
): Promise<CasResult> {
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  let statePaths: ReturnType<typeof paths>;

  if (!Number.isSafeInteger(input.expectedRevision)) {
    return {
      status: "state_error",
      state: initialState(),
      audit: stateErrorAudit(timestamp, input.routeId, input.domain),
    };
  }

  try {
    statePaths = paths(input.stateRoot, input.domain);
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
  } catch {
    return {
      status: "state_error",
      state: initialState(),
      audit: stateErrorAudit(timestamp, input.routeId, input.domain),
    };
  }

  const lock = await acquireLock(statePaths.lock, options);
  if (typeof lock === "string") {
    return {
      status: "state_error",
      state: initialState(),
      audit: stateErrorAudit(timestamp, input.routeId, input.domain),
    };
  }

  try {
    const current = await readDiskState(statePaths.state);
    if (!current.ok) {
      return {
        status: "state_error",
        state: initialState(),
        audit: stateErrorAudit(timestamp, input.routeId, input.domain),
      };
    }

    if (current.state.revision !== input.expectedRevision) {
      return { status: "revision_mismatch", state: current.state, audit: [] };
    }

    // revision + 1 must itself stay a safe integer, or CAS equality breaks.
    if (!Number.isSafeInteger(current.state.revision + 1)) {
      return {
        status: "state_error",
        state: current.state,
        audit: stateErrorAudit(timestamp, input.routeId, input.domain),
      };
    }

    const next: StateFile = {
      v: STATE_VERSION,
      revision: current.state.revision + 1,
      mode: input.mode,
      set_by: input.setBy,
      set_at: now().toISOString(),
      route_id: input.routeId,
    };

    try {
      await atomicWriteState(statePaths.state, statePaths.temporary, next);
    } catch (error) {
      try {
        await unlink(statePaths.temporary);
      } catch (cleanupError) {
        if (errno(cleanupError) !== "ENOENT") {
          // The primary write failure is the actionable error.
        }
      }
      return {
        status: "state_error",
        state: initialState(),
        audit: stateErrorAudit(timestamp, input.routeId, input.domain),
      };
    }

    return {
      status: "applied",
      state: next,
      previous: current.state,
      audit: [
        {
          ts: timestamp,
          event: "mode_transition",
          route_id: input.routeId,
          domain: input.domain,
          from: current.state.mode,
          to: input.mode,
          set_by: input.setBy,
        },
      ],
    };
  } finally {
    try {
      await releaseLock(statePaths.lock, lock);
    } catch {
      // The state replacement is already durable. A leftover lock is recovered
      // by the stale-lock protocol and must not turn an applied CAS into failure.
    }
  }
}

function rejection(
  input: CasInput,
  state: StateSnapshot,
  reason: string,
  timestamp: string,
): TransitionAttemptResult {
  const rejected: Rejected = {
    requested_mode: input.mode,
    reason,
  };

  return {
    status: "rejected",
    mode: state.mode,
    transitioned: false,
    state,
    rejected,
    audit: [
      {
        ts: timestamp,
        event: "switch_rejected",
        route_id: input.routeId,
        domain: input.domain,
        from: state.mode,
        reason,
      },
    ],
  };
}

/**
 * Runs one CAS, re-evaluates authorization against a fresh conflicting state,
 * and permits exactly one retry as required by SPEC §7.3.
 */
export async function attemptStateTransition(
  input: CasInput,
  reauthorize: (
    freshState: StateSnapshot,
  ) => Reevaluation | Promise<Reevaluation>,
  options: StoreOptions = {},
): Promise<TransitionAttemptResult> {
  const now = options.now ?? (() => new Date());
  const first = await compareAndSwapState(input, { ...options, now });

  if (first.status === "applied") {
    return {
      status: "applied",
      mode: first.state.mode,
      transitioned: true,
      state: first.state,
      audit: first.audit,
    };
  }
  if (first.status === "state_error") {
    return {
      status: "state_error",
      mode: "public",
      transitioned: false,
      state: first.state,
      audit: first.audit,
    };
  }

  const reevaluation = await reauthorize(first.state);
  if (!reevaluation.allowed) {
    return rejection(input, first.state, reevaluation.reason, now().toISOString());
  }

  const second = await compareAndSwapState(
    { ...input, expectedRevision: first.state.revision },
    { ...options, now },
  );
  if (second.status === "applied") {
    return {
      status: "applied",
      mode: second.state.mode,
      transitioned: true,
      state: second.state,
      audit: second.audit,
    };
  }
  if (second.status === "state_error") {
    return {
      status: "state_error",
      mode: "public",
      transitioned: false,
      state: second.state,
      audit: second.audit,
    };
  }

  return rejection(
    input,
    second.state,
    "state revision changed during the single transition retry",
    now().toISOString(),
  );
}
