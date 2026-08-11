import { assert, it } from "vite-plus/test";

import {
  ensureReviewBranchDiffScope,
  getReviewBranchDiffSnapshot,
  getReviewAsyncStateSnapshot,
  receiveReviewBranchDiffPage,
  requestNextReviewBranchDiffPage,
  setReviewAsyncError,
  setReviewTurnDiffLoading,
} from "./reviewState";

it("stores review async loading and error state in atoms", () => {
  const threadKey = `env-local:thread-review-state-${Date.now()}`;

  setReviewTurnDiffLoading(threadKey, "turn-1", true);
  setReviewAsyncError(threadKey, "load failed");

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingTurnIds: { "turn-1": true },
    error: "load failed",
  });

  setReviewTurnDiffLoading(threadKey, "turn-1", false);
  setReviewAsyncError(threadKey, null);

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingTurnIds: {},
    error: null,
  });
});

it("keeps branch pages scoped and requests each continuation once", () => {
  const threadKey = `env-local:thread-review-pages-${Date.now()}`;
  ensureReviewBranchDiffScope(threadKey, "scope-a");
  receiveReviewBranchDiffPage({
    threadKey,
    scopeKey: "scope-a",
    cursor: null,
    source: {
      id: "branch-range",
      kind: "branch-range",
      title: "Against main",
      baseRef: "base",
      headRef: "head",
      diff: "first",
      diffHash: "hash-1",
      truncated: false,
      nextCursor: "page-2",
      snapshotId: "snapshot",
    },
  });
  requestNextReviewBranchDiffPage(threadKey, "scope-a", "page-2");
  const requested = getReviewBranchDiffSnapshot(threadKey);
  requestNextReviewBranchDiffPage(threadKey, "scope-a", "page-2");

  assert.strictEqual(requested.pageState.requestCursor, "page-2");
  assert.strictEqual(getReviewBranchDiffSnapshot(threadKey).pageState, requested.pageState);

  receiveReviewBranchDiffPage({
    threadKey,
    scopeKey: "stale-scope",
    cursor: "page-2",
    source: {
      id: "branch-range",
      kind: "branch-range",
      title: "Against main",
      baseRef: "base",
      headRef: "head",
      diff: "stale",
      diffHash: "hash-stale",
      truncated: false,
      nextCursor: null,
      snapshotId: "stale",
    },
  });
  assert.deepStrictEqual(
    getReviewBranchDiffSnapshot(threadKey).pageState.slices.map((slice) => slice.patch),
    ["first"],
  );
});
