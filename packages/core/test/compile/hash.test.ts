import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { contentHash } from "../../src/compile/hash.js";

describe("contentHash", () => {
  it("sorts UTF-8 paths and hashes original bytes without LF normalization", () => {
    const expected = createHash("sha256")
      .update(Buffer.from("a.txt\0A\r\n\0b.txt\0B\n\0", "utf8"))
      .digest("hex");

    expect(contentHash([
      { path: "b.txt", bytes: Buffer.from("B\n") },
      { path: "a.txt", bytes: Buffer.from("A\r\n") },
    ])).toBe(expected);
    expect(contentHash([
      { path: "a.txt", bytes: Buffer.from("A\n") },
      { path: "b.txt", bytes: Buffer.from("B\n") },
    ])).not.toBe(expected);
  });
});
