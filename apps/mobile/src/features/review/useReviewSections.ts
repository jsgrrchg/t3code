import { useCallback, useEffect, useMemo } from "react";

import { selectNextDiffCursor } from "@t3tools/client-runtime/state/paged-diff";
import type { EnvironmentId, OrchestrationCheckpointSummary, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";
import {
  buildReviewBranchDiffScopeKey,
  ensureReviewBranchDiffScope,
  receiveReviewBranchDiffPage,
  requestNextReviewBranchDiffPage,
  resetReviewBranchDiff,
  setReviewAsyncError,
  setReviewBranchDiffRequestState,
  setReviewGitSections,
  setReviewGitSection,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const selectedThread = useSelectedThreadDetail();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const worktreeDiffPreview = useEnvironmentQuery(
    enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const branchScopeKey =
    reviewCache.threadKey && selectedThreadCwd
      ? buildReviewBranchDiffScopeKey(reviewCache.threadKey, selectedThreadCwd)
      : "inactive";
  const branchCursor =
    reviewCache.branchDiff.pageState.scopeKey === branchScopeKey
      ? reviewCache.branchDiff.pageState.requestCursor
      : null;
  const branchDiffPreview = useEnvironmentQuery(
    enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: {
            cwd: selectedThreadCwd,
            pagination: {
              sourceKind: "branch-range",
              ...(branchCursor ? { cursor: branchCursor } : {}),
            },
          },
        })
      : null,
  );
  const firstBranchDiffPreview = useEnvironmentQuery(
    enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: {
            cwd: selectedThreadCwd,
            pagination: { sourceKind: "branch-range" },
          },
        })
      : null,
  );
  const { loadingTurnIds } = reviewCache.asyncState;
  const branchCacheIsActive = reviewCache.branchDiff.pageState.scopeKey === branchScopeKey;
  const branchSlices = branchCacheIsActive ? reviewCache.branchDiff.pageState.slices : [];

  useEffect(() => {
    if (!reviewCache.threadKey) return;
    if (reviewCache.branchDiff.pageState.scopeKey !== branchScopeKey) {
      setReviewGitSections(
        reviewCache.threadKey,
        reviewCache.gitSections.filter((section) => section.kind !== "branch-range"),
      );
    }
    ensureReviewBranchDiffScope(reviewCache.threadKey, branchScopeKey);
  }, [
    branchScopeKey,
    reviewCache.branchDiff.pageState.scopeKey,
    reviewCache.gitSections,
    reviewCache.threadKey,
  ]);

  useEffect(() => {
    if (!reviewCache.threadKey || !worktreeDiffPreview.data) return;
    const workingTree = worktreeDiffPreview.data.sources.find(
      (source) => source.kind === "working-tree",
    );
    if (workingTree) setReviewGitSection(reviewCache.threadKey, workingTree);
  }, [reviewCache.threadKey, worktreeDiffPreview.data]);

  useEffect(() => {
    if (!reviewCache.threadKey) return;
    const source = branchDiffPreview.data?.sources.find(
      (candidate) => candidate.kind === "branch-range",
    );
    if (!source) return;
    receiveReviewBranchDiffPage({
      threadKey: reviewCache.threadKey,
      scopeKey: branchScopeKey,
      cursor: branchCursor,
      source,
    });
    setReviewGitSection(reviewCache.threadKey, source);
  }, [branchCursor, branchDiffPreview.data, branchScopeKey, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey) return;
    setReviewBranchDiffRequestState(reviewCache.threadKey, branchScopeKey, {
      isLoading: branchDiffPreview.isPending,
      error: branchDiffPreview.error,
    });
  }, [branchDiffPreview.error, branchDiffPreview.isPending, branchScopeKey, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, OrchestrationCheckpointSummary>,
    [readyCheckpoints],
  );
  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
        loadingGitSections: worktreeDiffPreview.isPending,
        branchDiffSlices: branchSlices,
        branchDiffLoading: branchCacheIsActive && reviewCache.branchDiff.isLoading,
        branchDiffLegacy: branchCacheIsActive && reviewCache.branchDiff.legacy,
      }),
    [
      worktreeDiffPreview.isPending,
      loadingTurnIds,
      readyCheckpoints,
      reviewCache.gitSections,
      reviewCache.branchDiff.isLoading,
      reviewCache.branchDiff.legacy,
      branchSlices,
      branchCacheIsActive,
      reviewCache.turnDiffById,
    ],
  );
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (selectedSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[selectedSection.id] ?? activeCheckpoint;
  }
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    setReviewTurnDiff(reviewCache.threadKey, activeSectionId, activeTurnDiff.data.diff);
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    if (selectedSection?.kind === "branch-range" && reviewCache.threadKey) {
      resetReviewBranchDiff(reviewCache.threadKey, branchScopeKey);
      setReviewGitSections(
        reviewCache.threadKey,
        reviewCache.gitSections.filter((section) => section.kind !== "branch-range"),
      );
      firstBranchDiffPreview.refresh();
      return;
    }
    worktreeDiffPreview.refresh();
  }, [
    activeTurnDiff,
    branchScopeKey,
    enabled,
    firstBranchDiffPreview,
    reviewCache.gitSections,
    reviewCache.threadKey,
    selectedSection?.kind,
    worktreeDiffPreview,
  ]);

  const prefetchBranchDiff = useCallback(() => {
    if (!reviewCache.threadKey || reviewCache.branchDiff.isLoading) return;
    const nextCursor = selectNextDiffCursor(branchSlices);
    if (nextCursor === null) return;
    requestNextReviewBranchDiffPage(reviewCache.threadKey, branchScopeKey, nextCursor);
  }, [branchScopeKey, reviewCache.branchDiff.isLoading, branchSlices, reviewCache.threadKey]);

  const retryBranchDiff = useCallback(() => {
    branchDiffPreview.refresh();
  }, [branchDiffPreview]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    error:
      worktreeDiffPreview.error ??
      reviewCache.branchDiff.error ??
      activeTurnDiff.error ??
      reviewCache.asyncState.error,
    loadingGitDiffs: worktreeDiffPreview.isPending || reviewCache.branchDiff.isLoading,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    prefetchBranchDiff,
    retryBranchDiff,
    selectSection,
  };
}
