import { describe, expect, it } from "vitest";

import { countPeTokens, effectiveBudget } from "../../src/compile/budget.js";

describe("pe-count-v1", () => {
  it("rounds UTF-8 byte lengths up in groups of three", () => {
    expect(countPeTokens("")).toBe(0);
    expect(countPeTokens("abc")).toBe(1);
    expect(countPeTokens("abcd")).toBe(2);
    expect(countPeTokens("ダ")).toBe(1);
    expect(countPeTokens("ダa")).toBe(2);
  });

  it("counts Uint8Array inputs by byte length", () => {
    expect(countPeTokens(new Uint8Array(0))).toBe(0);
    expect(countPeTokens(new Uint8Array(4))).toBe(2);
  });

  it("uses the global fallback and the lower mode limit", () => {
    expect(effectiveBudget(undefined, undefined, undefined)).toBe(600);
    expect(effectiveBudget(undefined, 100, undefined)).toBe(100);
    expect(effectiveBudget(80, 100, 90)).toBe(80);
    expect(effectiveBudget(undefined, 100, 90)).toBe(90);
  });
});
