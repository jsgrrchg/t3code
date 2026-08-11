import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ReviewDiffPreviewInput, ReviewDiffPreviewResult } from "./review.ts";

const decodePreviewInput = Schema.decodeUnknownSync(ReviewDiffPreviewInput);
const decodePreviewResult = Schema.decodeUnknownSync(ReviewDiffPreviewResult);

describe("review diff pagination contracts", () => {
  it("keeps the legacy request and response valid", () => {
    expect(decodePreviewInput({ cwd: "/repo" })).toEqual({ cwd: "/repo" });
    expect(
      decodePreviewResult({
        cwd: "/repo",
        generatedAt: "2026-08-11T00:00:00.000Z",
        sources: [
          {
            id: "branch-range",
            kind: "branch-range",
            title: "Against main",
            baseRef: "main",
            headRef: "feature",
            diff: "",
            diffHash: "hash",
            truncated: true,
          },
        ],
      }).sources[0]?.nextCursor,
    ).toBeUndefined();
  });

  it("decodes the paged source metadata", () => {
    const input = decodePreviewInput({
      cwd: "/repo",
      baseRef: "main",
      pagination: { sourceKind: "branch-range", cursor: "opaque" },
    });
    const result = decodePreviewResult({
      cwd: "/repo",
      generatedAt: "2026-08-11T00:00:00.000Z",
      sources: [
        {
          id: "branch-range",
          kind: "branch-range",
          title: "Against main",
          baseRef: "1111111111111111111111111111111111111111",
          headRef: "2222222222222222222222222222222222222222",
          diff: "patch",
          diffHash: "hash",
          truncated: false,
          nextCursor: null,
          snapshotId: "snapshot",
          stats: { fileCount: 1, additions: 2, deletions: 1 },
        },
      ],
    });

    expect(input.pagination?.cursor).toBe("opaque");
    expect(result.sources[0]?.stats).toEqual({ fileCount: 1, additions: 2, deletions: 1 });
  });

  it("opts working-tree previews into the same paged protocol", () => {
    const input = decodePreviewInput({
      cwd: "/repo",
      ignoreWhitespace: true,
      pagination: { sourceKind: "working-tree", cursor: "opaque" },
    });

    expect(input.pagination).toEqual({ sourceKind: "working-tree", cursor: "opaque" });
  });
});
