import type { DiffSliceResult } from "@t3tools/contracts";

export interface LoadedDiffSlice<
  Result extends DiffSliceResult = DiffSliceResult,
> extends DiffSliceResult {
  readonly cursor: string | null;
  readonly patch: Result["patch"];
  readonly truncated: Result["truncated"];
  readonly nextCursor: Result["nextCursor"];
}

export interface PagedDiffState<Result extends DiffSliceResult = DiffSliceResult> {
  readonly scopeKey: string;
  readonly requestCursor: string | null;
  readonly slices: ReadonlyArray<LoadedDiffSlice<Result>>;
}

export function createPagedDiffState<Result extends DiffSliceResult = DiffSliceResult>(
  scopeKey: string,
  slices: ReadonlyArray<LoadedDiffSlice<Result>> = [],
): PagedDiffState<Result> {
  return { scopeKey, requestCursor: null, slices };
}

export function resetPagedDiffState<Result extends DiffSliceResult = DiffSliceResult>(
  scopeKey: string,
  slices: ReadonlyArray<LoadedDiffSlice<Result>> = [],
): PagedDiffState<Result> {
  return createPagedDiffState(scopeKey, slices);
}

export function selectPagedDiffSlices<Result extends DiffSliceResult>(
  state: PagedDiffState<Result>,
  scopeKey: string,
  fallback: ReadonlyArray<LoadedDiffSlice<Result>> = [],
): ReadonlyArray<LoadedDiffSlice<Result>> {
  return state.scopeKey === scopeKey ? state.slices : fallback;
}

/**
 * Selects a usable continuation. A provider repeating a cursor would otherwise make an
 * intersection observer request the same page forever.
 */
export function selectNextDiffCursor<Result extends DiffSliceResult>(
  slices: ReadonlyArray<LoadedDiffSlice<Result>>,
): string | null {
  const nextCursor = slices.at(-1)?.nextCursor ?? null;
  if (nextCursor === null) return null;
  return slices.some((slice) => slice.cursor === nextCursor) ? null : nextCursor;
}

export function requestDiffSlice<Result extends DiffSliceResult>(
  state: PagedDiffState<Result>,
  scopeKey: string,
  cursor: string,
): PagedDiffState<Result> {
  if (state.scopeKey !== scopeKey || state.requestCursor === cursor) return state;
  if (selectNextDiffCursor(state.slices) !== cursor) return state;
  return { ...state, requestCursor: cursor };
}

export function receiveDiffSlice<Result extends DiffSliceResult>(
  state: PagedDiffState<Result>,
  input: {
    readonly scopeKey: string;
    readonly cursor: string | null;
    readonly result: Result;
  },
): PagedDiffState<Result> {
  if (state.scopeKey !== input.scopeKey) return state;

  const next: LoadedDiffSlice<Result> = { cursor: input.cursor, ...input.result };
  const index = state.slices.findIndex((slice) => slice.cursor === input.cursor);
  if (index === -1) {
    const expectedCursor = state.slices.at(-1)?.nextCursor ?? null;
    if (input.cursor !== expectedCursor) return state;
    return { ...state, requestCursor: input.cursor, slices: [...state.slices, next] };
  }

  const existing = state.slices[index];
  if (
    existing !== undefined &&
    existing.patch === next.patch &&
    existing.truncated === next.truncated &&
    existing.nextCursor === next.nextCursor
  ) {
    return state;
  }

  // Later cursors were positions in the result being replaced and are no longer trustworthy.
  return { ...state, requestCursor: input.cursor, slices: [...state.slices.slice(0, index), next] };
}
