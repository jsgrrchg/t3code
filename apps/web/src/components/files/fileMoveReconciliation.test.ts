import { describe, expect, it } from "vite-plus/test";

import type { ReviewCommentContext } from "~/reviewCommentContext";
import {
  clearPendingFileMoveSurfaces,
  remapComposerFileTokens,
  remapFileReviewComments,
  updatePendingFileSurface,
  workspaceFileStateKey,
} from "../../fileMoveReconciliation";

describe("file move composer reconciliation", () => {
  it("isolates pending file ids and move cleanup between worktrees", () => {
    const firstWorktreeKey = workspaceFileStateKey({
      environmentId: "env-1",
      projectWorkspaceRoot: "/repo",
      worktreePath: "/repo/.worktrees/first",
    });
    const secondWorktreeKey = workspaceFileStateKey({
      environmentId: "env-1",
      projectWorkspaceRoot: "/repo",
      worktreePath: "/repo/.worktrees/second",
    });
    expect(firstWorktreeKey).not.toBeNull();
    expect(secondWorktreeKey).not.toBeNull();
    expect(firstWorktreeKey).not.toBe(secondWorktreeKey);

    let pendingByWorkspace = new Map<string, ReadonlySet<string>>();
    pendingByWorkspace = new Map(
      updatePendingFileSurface(pendingByWorkspace, firstWorktreeKey!, "src/index.ts", true),
    );
    pendingByWorkspace = new Map(
      updatePendingFileSurface(pendingByWorkspace, secondWorktreeKey!, "src/index.ts", true),
    );
    pendingByWorkspace = new Map(
      clearPendingFileMoveSurfaces(
        pendingByWorkspace,
        firstWorktreeKey!,
        "src/index.ts",
        "lib/index.ts",
      ),
    );

    expect(pendingByWorkspace.has(firstWorktreeKey!)).toBe(false);
    expect(pendingByWorkspace.get(secondWorktreeKey!)).toEqual(new Set(["file:src/index.ts"]));
  });

  it("remaps exact file tokens from right to left", () => {
    const prompt =
      'Compare [my file (draft).md](docs/my%20file%20%28draft%29.md) with @"docs/my file (draft).md" and @docs/my-file.md ';

    expect(
      remapComposerFileTokens(prompt, "docs/my file (draft).md", "archive/my file (draft).md"),
    ).toBe(
      "Compare [my file (draft).md](archive/my%20file%20%28draft%29.md) with [my file (draft).md](archive/my%20file%20%28draft%29.md) and @docs/my-file.md ",
    );
  });

  it("does not replace plain text, URLs, partial paths, or other tokens", () => {
    const prompt =
      "docs/index.ts https://example.test/docs/index.ts @docs/index.tsx [index.ts](other/index.ts) ";

    expect(remapComposerFileTokens(prompt, "docs/index.ts", "src/index.ts")).toBe(prompt);
  });

  it("remaps a file token at the end of the draft", () => {
    expect(remapComposerFileTokens("Review @src/index.ts", "src/index.ts", "lib/index.ts")).toBe(
      "Review [index.ts](lib/index.ts)",
    );
  });

  it("remaps only exact file review comments", () => {
    const base = {
      id: "comment-1",
      sectionTitle: "File comment",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "Comment",
      diff: "diff",
    } satisfies Omit<ReviewCommentContext, "sectionId" | "filePath">;
    const comments: ReviewCommentContext[] = [
      { ...base, sectionId: "file:src/index.ts", filePath: "src/index.ts" },
      { ...base, id: "comment-2", sectionId: "turn:1", filePath: "src/index.ts" },
      { ...base, id: "comment-3", sectionId: "file:src/index.ts", filePath: "other.ts" },
    ];

    expect(remapFileReviewComments(comments, "src/index.ts", "components/index.ts")).toEqual([
      {
        ...comments[0],
        sectionId: "file:components/index.ts",
        filePath: "components/index.ts",
      },
      comments[1],
      comments[2],
    ]);
  });
});
