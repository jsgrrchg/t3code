import type {
  DiffSliceResult,
  EnvironmentId,
  ReviewDiffPreviewSource,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";

export function reviewDiffScopeKey(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly ignoreWhitespace: boolean;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.cwd,
    input.sourceKind,
    input.baseRef,
    input.ignoreWhitespace,
  ]);
}

export function reviewDiffPageFromSource(source: ReviewDiffPreviewSource): {
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
