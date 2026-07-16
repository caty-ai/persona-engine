import { describe, expect, it } from "vitest";

import { normalizeV1 } from "../../src/normalize.js";

describe("normalizeV1", () => {
  it("applies Unicode NFKC before the remaining normalization steps", () => {
    expect(normalizeV1("ＡＢＣ ﬃ Ⅳ")).toBe("abc ffi iv");
  });

  it("trims and collapses whitespace runs to one ASCII space", () => {
    expect(normalizeV1("\u0085\t  alpha\u3000\n\r beta\u00a0\ufeff")).toBe(
      "alpha beta",
    );
    expect(normalizeV1("\t\u3000\n\u0085")).toBe("");
  });

  it("lowercases ASCII characters only", () => {
    expect(normalizeV1("AZ az ÄÖ Σ Ж İ")).toBe("az az ÄÖ Σ Ж İ");
  });

  it("preserves punctuation and performs no other transformation", () => {
    expect(normalizeV1("  HELLO, world! /persona?  ")).toBe(
      "hello, world! /persona?",
    );
  });

  it("is idempotent", () => {
    const once = normalizeV1("  ＳＷＩＴＣＨ\tTO　DUMMY  ");

    expect(normalizeV1(once)).toBe(once);
  });
});
