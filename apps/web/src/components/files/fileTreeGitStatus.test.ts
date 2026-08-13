import { describe, expect, it } from "vite-plus/test";

import { toPierreGitStatus } from "./fileTreeGitStatus";

describe("toPierreGitStatus", () => {
  it("preserves classified statuses and treats legacy status files as modified", () => {
    expect(
      toPierreGitStatus([
        { path: "new.ts", status: "untracked", insertions: 0, deletions: 0 },
        { path: "renamed.ts", status: "renamed", insertions: 1, deletions: 1 },
        { path: "legacy.ts", insertions: 2, deletions: 0 },
      ]),
    ).toEqual([
      { path: "new.ts", status: "untracked" },
      { path: "renamed.ts", status: "renamed" },
      { path: "legacy.ts", status: "modified" },
    ]);
  });
});
