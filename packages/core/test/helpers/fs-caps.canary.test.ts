import { expect, it } from "vitest";

import {
  chmodDenialReason,
  mkfifoProbe,
  posixPermissionsReason,
  supportsChmodDenial,
  supportsPosixPermissions,
  supportsSymlinks,
  symlinkReason,
} from "./fs-caps.js";

const forcedNone = process.env.PERSONA_TEST_FORCE_FSCAPS === "none";
const supportedPlatform = process.platform === "linux" || process.platform === "darwin";

it("confirms the expected filesystem capabilities on Linux and macOS", (context) => {
  if (forcedNone) {
    context.skip(
      "PERSONA_TEST_FORCE_FSCAPS=none disabled supportsPosixPermissions, supportsChmodDenial, "
      + "supportsSymlinks, and mkfifo canary assertions for issue #47.",
    );
    return;
  }
  if (!supportedPlatform) {
    context.skip(
      `supportsPosixPermissions, supportsChmodDenial, supportsSymlinks, and mkfifo capability canary `
      + `is only asserted on Linux and macOS (observed ${process.platform}); see issue #47.`,
    );
    return;
  }

  const capabilities = [
    { name: "supportsPosixPermissions", ok: supportsPosixPermissions, reason: posixPermissionsReason },
    { name: "supportsChmodDenial", ok: supportsChmodDenial, reason: chmodDenialReason },
    { name: "supportsSymlinks", ok: supportsSymlinks, reason: symlinkReason },
    { name: "mkfifoProbe.ok", ok: mkfifoProbe.ok, reason: mkfifoProbe.reason },
  ];
  const measuredReasons = capabilities
    .map(({ name, ok, reason }) => `- ${name}=${String(ok)}: ${reason}`)
    .join("\n");

  expect(
    capabilities.every(({ ok }) => ok),
    `Filesystem capability canary failed for issue #47:\n${measuredReasons}`,
  ).toBe(true);
});
