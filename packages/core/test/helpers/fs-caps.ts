import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { TestContext } from "vitest";

type MkfifoProbe = {
  ok: boolean;
  reason: string;
};

type FsCaps = {
  supportsChmodDenial: boolean;
  supportsPosixPermissions: boolean;
  supportsSymlinks: boolean;
  chmodDenialReason: string;
  posixPermissionsReason: string;
  symlinkReason: string;
  mkfifoProbe: MkfifoProbe;
};

function issue47Reason(detail: string): string {
  return `${detail} This commonly happens on WSL2 DrvFs mounts such as /mnt/c; see issue #47.`;
}

function exactMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function spawnFailureDetail(result: ReturnType<typeof spawnSync>): string {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code ?? result.error.name;
    return `spawn error ${code}`;
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : result.stderr.toString("utf8").trim();
  return stderr === "" ? `exit status ${result.status ?? "unknown"}` : `exit status ${result.status ?? "unknown"}: ${stderr}`;
}

export function skipWithoutSymlinks(context: TestContext): boolean {
  if (supportsSymlinks) return false;
  context.skip(symlinkReason);
  return true;
}

export function mkfifoSpawnSkipDetail(result: ReturnType<typeof spawnSync>): string {
  return `${spawnFailureDetail(result)}. This commonly happens on WSL2 DrvFs mounts such as /mnt/c; see issue #47.`;
}

// Simulation-only override for issue #47 regression coverage; `none` force-disables
// all filesystem capability probes so tests can exercise skip paths deterministically.
const forcedNone = process.env.PERSONA_TEST_FORCE_FSCAPS === "none";

const fsCaps = (() => {
  if (forcedNone) {
    const posixPermissionsReason =
      "PERSONA_TEST_FORCE_FSCAPS=none disabled the exact chmod(0700) probe to simulate WSL2 DrvFs /mnt/c behavior from issue #47.";
    const chmodDenialReason =
      "PERSONA_TEST_FORCE_FSCAPS=none disabled the exact chmod(000) probe to simulate WSL2 DrvFs /mnt/c behavior from issue #47.";
    const symlinkReason =
      "PERSONA_TEST_FORCE_FSCAPS=none disabled symlink probes to simulate WSL2 DrvFs /mnt/c behavior from issue #47.";
    const mkfifoReason =
      "mkfifo unavailable/failed on this filesystem: PERSONA_TEST_FORCE_FSCAPS=none disabled mkfifo probes to simulate WSL2 DrvFs /mnt/c behavior from issue #47.";
    return {
      supportsChmodDenial: false,
      supportsPosixPermissions: false,
      supportsSymlinks: false,
      chmodDenialReason,
      posixPermissionsReason,
      symlinkReason,
      mkfifoProbe: { ok: false, reason: mkfifoReason },
    } satisfies FsCaps;
  }

  const root = mkdtempSync(resolve(tmpdir(), "persona-test-fs-caps-"));
  try {
    const permissionsPath = resolve(root, "permissions.txt");
    writeFileSync(permissionsPath, "permissions\n", "utf8");
    let supportsPosixPermissions = false;
    let posixPermissionsReason = "Exact chmod(0700) round-tripped on the probe file.";
    try {
      chmodSync(permissionsPath, 0o700);
      const mode = exactMode(permissionsPath);
      supportsPosixPermissions = mode === 0o700;
      if (!supportsPosixPermissions) {
        posixPermissionsReason = issue47Reason(
          `Exact chmod(0700) did not round-trip on the probe file (observed ${mode.toString(8).padStart(3, "0")}).`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      posixPermissionsReason = issue47Reason(`chmod(0700) failed during the filesystem capability probe (${code}).`);
    }

    const denialPath = resolve(root, "denial.txt");
    writeFileSync(denialPath, "deny me\n", "utf8");
    let supportsChmodDenial = false;
    let chmodDenialReason = "Exact chmod(000) round-tripped on the probe file.";
    try {
      chmodSync(denialPath, 0o000);
      const mode = exactMode(denialPath);
      supportsChmodDenial = mode === 0o000;
      if (!supportsChmodDenial) {
        chmodDenialReason = issue47Reason(
          `Exact chmod(000) did not round-trip on the probe file (observed ${mode.toString(8).padStart(3, "0")}).`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      chmodDenialReason = issue47Reason(`chmod(000) failed during the filesystem capability probe (${code}).`);
    }

    const fileTarget = resolve(root, "symlink-target.txt");
    const fileLink = resolve(root, "symlink-file");
    const dirTarget = resolve(root, "symlink-target-dir");
    const dirLink = resolve(root, "symlink-dir");
    writeFileSync(fileTarget, "link target\n", "utf8");
    mkdirSync(dirTarget);
    let supportsSymlinks = false;
    let symlinkReason = "File and directory symlink probes both resolved successfully.";
    try {
      symlinkSync(fileTarget, fileLink, "file");
      symlinkSync(dirTarget, dirLink, "dir");
      supportsSymlinks = statSync(fileLink).isFile() && statSync(dirLink).isDirectory();
      if (!supportsSymlinks) {
        symlinkReason = issue47Reason(
          "Symlink creation completed, but the links did not resolve as a file and directory pair.",
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      symlinkReason = issue47Reason(`Symlink creation failed during the filesystem capability probe (${code}).`);
    }

    const fifoPath = resolve(root, "probe.fifo");
    const fifoResult = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    const mkfifoProbe = fifoResult.status === 0 && fifoResult.error === undefined
      ? { ok: true, reason: "mkfifo succeeded on the probe path." }
      : {
          ok: false,
          reason: `mkfifo unavailable/failed on this filesystem: ${
            issue47Reason(`mkfifo is unavailable for this filesystem capability probe (${spawnFailureDetail(fifoResult)}).`)
          }`,
        };

    return {
      supportsChmodDenial,
      supportsPosixPermissions,
      supportsSymlinks,
      chmodDenialReason,
      posixPermissionsReason,
      symlinkReason,
      mkfifoProbe,
    } satisfies FsCaps;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

export const supportsPosixPermissions = fsCaps.supportsPosixPermissions;
export const posixPermissionsReason = fsCaps.posixPermissionsReason;
export const supportsChmodDenial = fsCaps.supportsChmodDenial;
export const chmodDenialReason = fsCaps.chmodDenialReason;
export const supportsSymlinks = fsCaps.supportsSymlinks;
export const symlinkReason = fsCaps.symlinkReason;
export const mkfifoProbe = fsCaps.mkfifoProbe;
