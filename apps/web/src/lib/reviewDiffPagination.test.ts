import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewDiffPageFromSource, reviewDiffScopeKey } from "./reviewDiffPagination.ts";

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

describe("review diff pagination", () => {
  it("recognizes an old server response as one legacy page", () => {
    expect(reviewDiffPageFromSource(source())).toEqual({
      result: { patch: "patch", truncated: false, nextCursor: null },
      legacy: true,
    });
  });

  it("keeps pagination separate from withheld content", () => {
    expect(
      reviewDiffPageFromSource(
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
      sourceKind: "branch-range" as const,
      baseRef: "main",
      ignoreWhitespace: false,
    };
    const scope = reviewDiffScopeKey(common);

    expect(reviewDiffScopeKey({ ...common, baseRef: "develop" })).not.toBe(scope);
    expect(reviewDiffScopeKey({ ...common, ignoreWhitespace: true })).not.toBe(scope);
    expect(reviewDiffScopeKey({ ...common, cwd: "/other" })).not.toBe(scope);
    expect(reviewDiffScopeKey({ ...common, sourceKind: "working-tree" })).not.toBe(scope);
  });
});
