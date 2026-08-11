import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { branchDiffPageFromSource, branchReviewDiffScopeKey } from "./reviewDiffPagination.ts";

const source = (overrides: Partial<ReviewDiffPreviewSource> = {}): ReviewDiffPreviewSource => ({
  id: "branch-range",
  kind: "branch-range",
  title: "Against main",
  baseRef: "base",
  headRef: "head",
  diff: "patch",
  diffHash: "hash",
  truncated: false,
  ...overrides,
});

describe("branch review diff pagination", () => {
  it("recognizes an old server response as one legacy page", () => {
    expect(branchDiffPageFromSource(source())).toEqual({
      result: { patch: "patch", truncated: false, nextCursor: null },
      legacy: true,
    });
  });

  it("keeps pagination separate from withheld content", () => {
    expect(
      branchDiffPageFromSource(
        source({ nextCursor: "page-2", snapshotId: "snapshot", truncated: true }),
      ),
    ).toEqual({
      result: { patch: "patch", truncated: true, nextCursor: "page-2" },
      legacy: false,
    });
  });

  it("changes scope when the comparison inputs change", () => {
    const common = {
      environmentId: EnvironmentId.make("environment"),
      cwd: "/repo",
      baseRef: "main",
      ignoreWhitespace: false,
    };
    const scope = branchReviewDiffScopeKey(common);

    expect(branchReviewDiffScopeKey({ ...common, baseRef: "develop" })).not.toBe(scope);
    expect(branchReviewDiffScopeKey({ ...common, ignoreWhitespace: true })).not.toBe(scope);
    expect(branchReviewDiffScopeKey({ ...common, cwd: "/other" })).not.toBe(scope);
  });
});
