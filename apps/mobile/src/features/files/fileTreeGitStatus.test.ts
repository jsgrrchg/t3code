import { describe, expect, it } from "vite-plus/test";

import { buildFileTreeGitPresentation } from "./fileTreeGitStatus";

describe("buildFileTreeGitPresentation", () => {
  it("classifies files and marks every changed ancestor", () => {
    const presentation = buildFileTreeGitPresentation([
      {
        path: "apps/mobile/src/index.ts",
        status: "untracked",
        insertions: 0,
        deletions: 0,
      },
      { path: "README.md", insertions: 1, deletions: 0 },
    ]);

    expect([...presentation.statusByPath]).toEqual([
      ["apps/mobile/src/index.ts", "untracked"],
      ["README.md", "modified"],
    ]);
    expect([...presentation.directoriesWithChanges]).toEqual([
      "apps",
      "apps/mobile",
      "apps/mobile/src",
    ]);
  });
});
