import { describe, expect, it } from "vite-plus/test";

import {
  createPagedDiffState,
  receiveDiffSlice,
  requestDiffSlice,
  selectNextDiffCursor,
} from "./pagedDiff.ts";

const first = { patch: "first", truncated: false, nextCursor: "page-2" };
const second = { patch: "second", truncated: false, nextCursor: null };

describe("paged diff state", () => {
  it("appends responses in cursor order", () => {
    const initial = createPagedDiffState("scope");
    const withFirst = receiveDiffSlice(initial, { scopeKey: "scope", cursor: null, result: first });
    const requested = requestDiffSlice(withFirst, "scope", "page-2");
    const complete = receiveDiffSlice(requested, {
      scopeKey: "scope",
      cursor: "page-2",
      result: second,
    });

    expect(complete.slices.map((slice) => slice.patch)).toEqual(["first", "second"]);
    expect(selectNextDiffCursor(complete.slices)).toBeNull();
  });

  it("replaces a changed response and discards later cursors", () => {
    const state = createPagedDiffState("scope", [
      { cursor: null, ...first },
      { cursor: "page-2", ...second },
    ]);

    const replaced = receiveDiffSlice(state, {
      scopeKey: "scope",
      cursor: null,
      result: { ...first, patch: "refreshed" },
    });

    expect(replaced.slices).toEqual([{ cursor: null, ...first, patch: "refreshed" }]);
  });

  it("uses a result-specific comparison for extended slice data", () => {
    const result = { ...first, stats: [{ path: "a.ts", additions: 1 }] };
    const state = createPagedDiffState<typeof result>("scope", [{ cursor: null, ...result }]);
    const refreshed = receiveDiffSlice(state, {
      scopeKey: "scope",
      cursor: null,
      result: { ...result, stats: [{ path: "a.ts", additions: 2 }] },
      areResultsEqual: (existing, next) =>
        existing.patch === next.patch && existing.stats[0]?.additions === next.stats[0]?.additions,
    });

    expect(refreshed.slices[0]?.stats[0]?.additions).toBe(2);
  });

  it("ignores a response from an old scope", () => {
    const state = createPagedDiffState("current", [{ cursor: null, ...first }]);
    expect(
      receiveDiffSlice(state, { scopeKey: "previous", cursor: "page-2", result: second }),
    ).toBe(state);
  });

  it("does not request or expose a repeated continuation cursor", () => {
    const repeated = createPagedDiffState("scope", [
      { cursor: null, ...first },
      { cursor: "page-2", patch: "second", truncated: false, nextCursor: "page-2" },
    ]);

    expect(selectNextDiffCursor(repeated.slices)).toBeNull();
    expect(requestDiffSlice(repeated, "scope", "page-2")).toBe(repeated);
  });
});
