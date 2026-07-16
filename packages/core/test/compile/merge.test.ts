import { describe, expect, it } from "vitest";

import { deepMerge, mergeIdList } from "../../src/compile/merge.js";

describe("inheritance merge", () => {
  it("keeps replacement positions, removes ids, and appends new ids in child order", () => {
    const result = mergeIdList(
      [
        { id: "first", text: "one" },
        { id: "replace", text: "old" },
        { id: "remove", text: "gone" },
      ],
      [
        { id: "replace", text: "new" },
        { id: "remove", remove: true },
        { id: "append-b", text: "b" },
        { id: "append-a", text: "a" },
      ],
      ["text"],
    );

    expect(result.issues).toEqual([]);
    expect(result.items).toEqual([
      { id: "first", text: "one" },
      { id: "replace", text: "new" },
      { id: "append-b", text: "b" },
      { id: "append-a", text: "a" },
    ]);
  });

  it("deep-merges maps with child priority while replacing arrays and scalars", () => {
    expect(deepMerge(
      { nested: { left: 1, shared: "parent" }, list: [1], scalar: 1 },
      { nested: { right: 2, shared: "child" }, list: [2], scalar: 2 },
    )).toEqual({
      nested: { left: 1, right: 2, shared: "child" },
      list: [2],
      scalar: 2,
    });
  });

  it("reports conflicting and unknown removals", () => {
    expect(mergeIdList([], [{ id: "x", remove: true, text: "bad" }], ["text"]).issues)
      .toEqual([{ kind: "conflict", id: "x" }]);
    expect(mergeIdList([], [{ id: "x", remove: true }], ["text"]).issues)
      .toEqual([{ kind: "unknown", id: "x" }]);
  });
});
