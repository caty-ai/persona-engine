import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeResult = vi.hoisted(() => ({
  value: {
    mode: "public",
    block: "",
    route_id: "__default__",
    state_domain: "quarantine",
    transitioned: false,
    audit: [
      { ts: "2026-01-01T00:00:00.000Z", event: "state_error", route_id: "__default__", domain: "quarantine" },
      { ts: "2026-01-01T00:00:00.000Z", event: "build_invalid", route_id: "__default__", domain: "quarantine" },
    ],
  },
}));

vi.mock("../../src/turn/index.js", () => ({
  cliInternalTurnAdmin: vi.fn(async () => runtimeResult.value),
  set: vi.fn(),
}));

import { main } from "../../src/cli/index.js";

afterEach(() => vi.restoreAllMocks());

describe("CLI runtime exit priority", () => {
  it("chooses build error over simultaneous state error", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["turn", "--dir", resolve("dummy-install")])).resolves.toBe(1);
    expect(output).toHaveBeenCalled();
  });
});
