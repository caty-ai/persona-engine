import { describe, expect, it } from "vitest";

import { routesOverlap } from "../../src/compile/routes.js";

describe("routesOverlap", () => {
  it.each([
    ["missing key is unconstrained", { platform: "x" }, { platform: "x", session_id: "one" }],
    ["equal strings", { platform: "x" }, { platform: "x" }],
    ["string intersects prefix", { session_id: "dummy-123" }, { session_id: { prefix: "dummy-" } }],
    ["nested prefixes intersect", { session_id: { prefix: "dummy-" } }, { session_id: { prefix: "dummy-private-" } }],
    ["match keys are fully disjoint", { platform: "a" }, { session_key: "b" }],
    ["one match is empty", {}, { platform: "anything", session_id: { prefix: "x" } }],
  ] as const)("detects overlap when %s", (_label, left, right) => {
    expect(routesOverlap({ match: left }, { match: right })).toBe(true);
  });

  it("rejects a pair when any union key is disjoint", () => {
    expect(routesOverlap(
      { match: { platform: "left", session_id: { prefix: "same-" } } },
      { match: { platform: "right", session_id: { prefix: "same-extended-" } } },
    )).toBe(false);
  });
});
