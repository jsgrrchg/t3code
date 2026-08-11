import { useAtomValue } from "@effect/atom-react";
import {
  createPagedDiffState,
  receiveDiffSlice,
  requestDiffSlice,
  type PagedDiffState,
} from "@t3tools/client-runtime/state/paged-diff";

import type { EnvironmentId, ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  buildReviewParsedDiff,
  combineReviewParsedDiffSlices,
  type ReviewParsedDiff,
} from "./reviewModel";

const EMPTY_GIT_REVIEW_SECTIONS = Object.freeze<ReadonlyArray<ReviewDiffPreviewSource>>([]);
const EMPTY_REVIEW_TURN_DIFFS = Object.freeze<Readonly<Record<string, string>>>({});
const EMPTY_REVIEW_LOADING_TURN_IDS = Object.freeze<Readonly<Record<string, boolean>>>({});
const EMPTY_REVIEW_ASYNC_STATE = Object.freeze<ReviewAsyncState>({
  loadingTurnIds: EMPTY_REVIEW_LOADING_TURN_IDS,
  error: null,
});
const EMPTY_REVIEW_BRANCH_DIFF = Object.freeze<ReviewBranchDiffCache>({
  pageState: createPagedDiffState("inactive"),
  source: null,
  legacy: false,
  isLoading: false,
  error: null,
});
const EMPTY_REVIEW_SECTION_FILE_IDS = Object.freeze<
  Readonly<Record<string, ReadonlyArray<string> | undefined>>
>({});
const EMPTY_REVIEW_GIT_SECTIONS_ATOM = Atom.make(EMPTY_GIT_REVIEW_SECTIONS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:git-sections:null"),
);
const EMPTY_REVIEW_TURN_DIFFS_ATOM = Atom.make(EMPTY_REVIEW_TURN_DIFFS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:turn-diffs:null"),
);
const EMPTY_REVIEW_SELECTED_SECTION_ID_ATOM = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:selected-section-id:null"),
);
const EMPTY_REVIEW_ASYNC_STATE_ATOM = Atom.make(EMPTY_REVIEW_ASYNC_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:async-state:null"),
);
const EMPTY_REVIEW_BRANCH_DIFF_ATOM = Atom.make(EMPTY_REVIEW_BRANCH_DIFF).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:branch-diff:null"),
);
const EMPTY_REVIEW_SECTION_FILE_IDS_ATOM = Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:section-file-ids:null"),
);

const reviewGitSectionsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_GIT_REVIEW_SECTIONS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:git-sections:${threadKey}`),
  ),
);

const reviewTurnDiffByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_TURN_DIFFS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:turn-diffs:${threadKey}`),
  ),
);

const reviewSelectedSectionIdByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make<string | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:selected-section-id:${threadKey}`),
  ),
);

const reviewAsyncStateByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_ASYNC_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:async-state:${threadKey}`),
  ),
);
const reviewBranchDiffByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_BRANCH_DIFF).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:branch-diff:${threadKey}`),
  ),
);

const reviewExpandedFileIdsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:expanded-file-ids:${threadKey}`),
  ),
);

const reviewRevealedLargeFileIdsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:revealed-large-file-ids:${threadKey}`),
  ),
);

const reviewViewedFileIdsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:viewed-file-ids:${threadKey}`),
  ),
);

const reviewParsedDiffBySectionCacheKeyAtom = Atom.family((cacheKey: string) =>
  Atom.make<{ readonly diff: string | null; readonly parsed: ReviewParsedDiff } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:parsed-diffs:${cacheKey}`),
  ),
);

export interface ReviewCacheForThread {
  readonly threadKey: string | null;
  readonly gitSections: ReadonlyArray<ReviewDiffPreviewSource>;
  readonly turnDiffById: Readonly<Record<string, string>>;
  readonly selectedSectionId: string | null;
  readonly asyncState: ReviewAsyncState;
  readonly branchDiff: ReviewBranchDiffCache;
  readonly expandedFileIdsBySection: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
  readonly revealedLargeFileIdsBySection: Readonly<
    Record<string, ReadonlyArray<string> | undefined>
  >;
  readonly viewedFileIdsBySection: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}

export interface ReviewBranchDiffCache {
  readonly pageState: PagedDiffState;
  readonly source: ReviewDiffPreviewSource | null;
  readonly legacy: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export interface ReviewAsyncState {
  readonly loadingTurnIds: Readonly<Record<string, boolean>>;
  readonly error: string | null;
}

function buildThreadKey(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}): string | null {
  return input.environmentId && input.threadId
    ? scopedThreadKey(input.environmentId, input.threadId)
    : null;
}

function buildSectionCacheKey(threadKey: string, sectionId: string): string {
  return `${threadKey}:${sectionId}`;
}

export function buildReviewBranchDiffScopeKey(threadKey: string, cwd: string): string {
  return JSON.stringify([threadKey, cwd]);
}

export function useReviewCacheForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}): ReviewCacheForThread {
  const threadKey = buildThreadKey(input);
  const gitSections = useAtomValue(
    threadKey ? reviewGitSectionsByThreadKeyAtom(threadKey) : EMPTY_REVIEW_GIT_SECTIONS_ATOM,
  );
  const turnDiffById = useAtomValue(
    threadKey ? reviewTurnDiffByThreadKeyAtom(threadKey) : EMPTY_REVIEW_TURN_DIFFS_ATOM,
  );
  const selectedSectionId = useAtomValue(
    threadKey
      ? reviewSelectedSectionIdByThreadKeyAtom(threadKey)
      : EMPTY_REVIEW_SELECTED_SECTION_ID_ATOM,
  );
  const asyncState = useAtomValue(
    threadKey ? reviewAsyncStateByThreadKeyAtom(threadKey) : EMPTY_REVIEW_ASYNC_STATE_ATOM,
  );
  const branchDiff = useAtomValue(
    threadKey ? reviewBranchDiffByThreadKeyAtom(threadKey) : EMPTY_REVIEW_BRANCH_DIFF_ATOM,
  );
  const expandedFileIdsBySection = useAtomValue(
    threadKey
      ? reviewExpandedFileIdsByThreadKeyAtom(threadKey)
      : EMPTY_REVIEW_SECTION_FILE_IDS_ATOM,
  );
  const revealedLargeFileIdsBySection = useAtomValue(
    threadKey
      ? reviewRevealedLargeFileIdsByThreadKeyAtom(threadKey)
      : EMPTY_REVIEW_SECTION_FILE_IDS_ATOM,
  );
  const viewedFileIdsBySection = useAtomValue(
    threadKey ? reviewViewedFileIdsByThreadKeyAtom(threadKey) : EMPTY_REVIEW_SECTION_FILE_IDS_ATOM,
  );

  return {
    threadKey,
    gitSections,
    turnDiffById,
    selectedSectionId,
    asyncState,
    branchDiff,
    expandedFileIdsBySection,
    revealedLargeFileIdsBySection,
    viewedFileIdsBySection,
  };
}

export function ensureReviewBranchDiffScope(threadKey: string, scopeKey: string): void {
  const atom = reviewBranchDiffByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  if (current.pageState.scopeKey === scopeKey) return;
  appAtomRegistry.set(atom, {
    pageState: createPagedDiffState(scopeKey),
    source: null,
    legacy: false,
    isLoading: false,
    error: null,
  });
}

export function resetReviewBranchDiff(threadKey: string, scopeKey: string): void {
  const atom = reviewBranchDiffByThreadKeyAtom(threadKey);
  appAtomRegistry.set(atom, {
    pageState: createPagedDiffState(scopeKey),
    source: null,
    legacy: false,
    isLoading: false,
    error: null,
  });
}

export function receiveReviewBranchDiffPage(input: {
  readonly threadKey: string;
  readonly scopeKey: string;
  readonly cursor: string | null;
  readonly source: ReviewDiffPreviewSource;
}): void {
  const atom = reviewBranchDiffByThreadKeyAtom(input.threadKey);
  const current = appAtomRegistry.get(atom);
  if (current.pageState.scopeKey !== input.scopeKey) return;
  appAtomRegistry.set(atom, {
    ...current,
    pageState: receiveDiffSlice(current.pageState, {
      scopeKey: input.scopeKey,
      cursor: input.cursor,
      result: {
        patch: input.source.diff,
        truncated: input.source.truncated,
        nextCursor: input.source.nextCursor ?? null,
      },
    }),
    source: input.source,
    legacy: input.source.nextCursor === undefined || input.source.snapshotId === undefined,
    isLoading: false,
    error: null,
  });
}

export function requestNextReviewBranchDiffPage(
  threadKey: string,
  scopeKey: string,
  cursor: string,
): void {
  const atom = reviewBranchDiffByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const pageState = requestDiffSlice(current.pageState, scopeKey, cursor);
  if (pageState === current.pageState) return;
  appAtomRegistry.set(atom, { ...current, pageState, isLoading: true, error: null });
}

export function setReviewBranchDiffRequestState(
  threadKey: string,
  scopeKey: string,
  state: { readonly isLoading: boolean; readonly error: string | null },
): void {
  const atom = reviewBranchDiffByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  if (current.pageState.scopeKey !== scopeKey) return;
  appAtomRegistry.set(atom, { ...current, ...state });
}

export function getReviewBranchDiffSnapshot(threadKey: string): ReviewBranchDiffCache {
  return appAtomRegistry.get(reviewBranchDiffByThreadKeyAtom(threadKey));
}

export function setReviewGitSections(
  threadKey: string,
  sections: ReadonlyArray<ReviewDiffPreviewSource>,
): void {
  appAtomRegistry.set(reviewGitSectionsByThreadKeyAtom(threadKey), sections);
}

export function setReviewGitSection(threadKey: string, section: ReviewDiffPreviewSource): void {
  const atom = reviewGitSectionsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const withoutKind = current.filter((candidate) => candidate.kind !== section.kind);
  const next =
    section.kind === "working-tree" ? [section, ...withoutKind] : [...withoutKind, section];
  appAtomRegistry.set(atom, next);
}

export function setReviewTurnDiff(threadKey: string, sectionId: string, diff: string): void {
  const atom = reviewTurnDiffByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: diff,
  });
}

export function setReviewSelectedSectionId(threadKey: string, sectionId: string | null): void {
  appAtomRegistry.set(reviewSelectedSectionIdByThreadKeyAtom(threadKey), sectionId);
}

function updateReviewAsyncState(
  threadKey: string,
  update: (current: ReviewAsyncState) => ReviewAsyncState,
): void {
  const atom = reviewAsyncStateByThreadKeyAtom(threadKey);
  appAtomRegistry.set(atom, update(appAtomRegistry.get(atom)));
}

export function setReviewTurnDiffLoading(
  threadKey: string,
  sectionId: string,
  isLoading: boolean,
): void {
  updateReviewAsyncState(threadKey, (current) => {
    const loadingTurnIds = { ...current.loadingTurnIds };
    if (isLoading) {
      loadingTurnIds[sectionId] = true;
    } else {
      delete loadingTurnIds[sectionId];
    }
    return {
      ...current,
      loadingTurnIds,
    };
  });
}

export function setReviewAsyncError(threadKey: string, error: string | null): void {
  updateReviewAsyncState(threadKey, (current) => ({
    ...current,
    error,
  }));
}

export function getReviewAsyncStateSnapshot(threadKey: string): ReviewAsyncState {
  return appAtomRegistry.get(reviewAsyncStateByThreadKeyAtom(threadKey));
}

export function updateReviewExpandedFileIds(
  threadKey: string,
  sectionId: string,
  update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
): void {
  const atom = reviewExpandedFileIdsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const nextValue = update(current[sectionId]);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: nextValue,
  });
}

export function updateReviewRevealedLargeFileIds(
  threadKey: string,
  sectionId: string,
  update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
): void {
  const atom = reviewRevealedLargeFileIdsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const nextValue = update(current[sectionId]);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: nextValue,
  });
}

export function updateReviewViewedFileIds(
  threadKey: string,
  sectionId: string,
  update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
): void {
  const atom = reviewViewedFileIdsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const nextValue = update(current[sectionId]);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: nextValue,
  });
}

export function getCachedReviewParsedDiff(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly diff: string | null | undefined;
}): ReviewParsedDiff {
  if (!input.threadKey || !input.sectionId) {
    return buildReviewParsedDiff(input.diff, input.sectionId ?? "mobile-review");
  }

  const cacheKey = buildSectionCacheKey(input.threadKey, input.sectionId);
  const normalizedDiff = input.diff?.trim() ?? null;
  const atom = reviewParsedDiffBySectionCacheKeyAtom(cacheKey);
  const cached = appAtomRegistry.get(atom);
  if (cached && cached.diff === normalizedDiff) {
    return cached.parsed;
  }

  const parsed = buildReviewParsedDiff(input.diff, input.sectionId);
  appAtomRegistry.set(atom, {
    diff: normalizedDiff,
    parsed,
  });
  return parsed;
}

export function getCachedReviewParsedDiffSlices(input: {
  readonly threadKey: string | null;
  readonly sectionId: string;
  readonly snapshotId: string;
  readonly slices: PagedDiffState["slices"];
  readonly stats?: {
    readonly fileCount: number;
    readonly additions: number;
    readonly deletions: number;
  };
  readonly legacy: boolean;
}): ReviewParsedDiff {
  const parsedSlices = input.slices.map((slice) =>
    getCachedReviewParsedDiff({
      threadKey: input.threadKey,
      sectionId: `${input.sectionId}:slice:${input.snapshotId}:${slice.cursor ?? "first"}`,
      diff: slice.patch,
    }),
  );
  return combineReviewParsedDiffSlices({
    slices: input.slices,
    parsedSlices,
    ...(input.stats ? { stats: input.stats } : {}),
    legacy: input.legacy,
  });
}
