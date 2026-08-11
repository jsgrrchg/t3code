import type { DiffSliceResult, EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";

export function branchReviewDiffScopeKey(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly baseRef: string | null;
  readonly ignoreWhitespace: boolean;
}): string {
  return JSON.stringify([input.environmentId, input.cwd, input.baseRef, input.ignoreWhitespace]);
}

export function branchDiffPageFromSource(source: ReviewDiffPreviewSource): {
  readonly result: DiffSliceResult;
  readonly legacy: boolean;
} {
  return {
    result: {
      patch: source.diff,
      truncated: source.truncated,
      nextCursor: source.nextCursor ?? null,
    },
    legacy: source.nextCursor === undefined || source.snapshotId === undefined,
  };
}
