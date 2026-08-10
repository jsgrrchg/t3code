import {
  GitObjectId,
  type GitHistoryCommitSummary,
  type GitObjectId as GitObjectIdType,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { layoutGitHistoryGraph, type GitHistoryGraphRow } from "./gitHistoryGraphLayout";

function sha(value: number): GitObjectIdType {
  return GitObjectId.make(value.toString(16).padStart(40, "0"));
}

function commit(value: number, parents: ReadonlyArray<number> = []): GitHistoryCommitSummary {
  return {
    sha: sha(value),
    parentShas: parents.map(sha),
    subject: `Commit ${value}`,
    authorName: "Test Author",
    authorEmail: "test@example.com",
    authoredAt: "2026-08-10T00:00:00Z",
    refs: [],
  };
}

function segments(row: GitHistoryGraphRow, shape: GitHistoryGraphRow["segments"][number]["shape"]) {
  return row.segments.filter((segment) => segment.shape === shape);
}

describe("layoutGitHistoryGraph", () => {
  it("keeps a linear history in one continuous lane", () => {
    const layout = layoutGitHistoryGraph([commit(3, [2]), commit(2, [1]), commit(1)]);

    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0, 0]);
    expect(layout.rows.map((row) => row.laneCountAfter)).toEqual([1, 1, 0]);
    expect(layout.rows.map((row) => row.nodeColorId)).toEqual([0, 0, 0]);
    expect(layout.maxLaneCount).toBe(1);
  });

  it("keeps both sides of an unmerged fork open until their shared parent", () => {
    const layout = layoutGitHistoryGraph([commit(3, [1]), commit(2, [1]), commit(1)]);
    const sharedParent = layout.rows[2];

    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 1, 0]);
    expect(layout.rows[1]?.laneCountAfter).toBe(2);
    expect(segments(sharedParent!, "incoming")).toMatchObject([
      { fromLane: 0, toLane: 0, colorId: 0 },
      { fromLane: 1, toLane: 0, colorId: 1 },
    ]);
  });

  it("lays out a two-parent merge and compacts the remaining lane", () => {
    const layout = layoutGitHistoryGraph([commit(3, [2, 1]), commit(2), commit(1)]);
    const merge = layout.rows[0]!;
    const firstParent = layout.rows[1]!;
    const secondParent = layout.rows[2]!;

    expect(segments(merge, "outgoing")).toMatchObject([
      { fromLane: 0, toLane: 0, colorId: 0 },
      { fromLane: 0, toLane: 1, colorId: 1 },
    ]);
    expect(segments(firstParent, "through")).toContainEqual({
      fromLane: 1,
      toLane: 0,
      colorId: 1,
      shape: "through",
    });
    expect(secondParent.nodeLane).toBe(0);
    expect(secondParent.nodeColorId).toBe(1);
  });

  it("opens one stable lane for every parent in an octopus merge", () => {
    const layout = layoutGitHistoryGraph([commit(4, [3, 2, 1]), commit(3), commit(2), commit(1)]);
    const outgoing = segments(layout.rows[0]!, "outgoing");

    expect(outgoing.map(({ toLane }) => toLane)).toEqual([0, 1, 2]);
    expect(new Set(outgoing.map(({ colorId }) => colorId)).size).toBe(3);
    expect(layout.maxLaneCount).toBe(3);
  });

  it("connects an additional parent to its already-open lane", () => {
    const layout = layoutGitHistoryGraph([
      commit(5, [4, 2]),
      commit(4, [3, 2]),
      commit(3),
      commit(2),
    ]);
    const firstMerge = layout.rows[0]!;
    const secondMerge = layout.rows[1]!;
    const openParentEdge = segments(firstMerge, "outgoing")[1]!;
    const reusedParentEdge = segments(secondMerge, "outgoing")[1]!;

    expect(secondMerge.laneCountAfter).toBe(2);
    expect(reusedParentEdge.toLane).toBe(1);
    expect(reusedParentEdge.colorId).toBe(openParentEdge.colorId);
  });

  it("supports disconnected roots and reuses their closed visual lane with a new color", () => {
    const layout = layoutGitHistoryGraph([commit(2), commit(1)]);

    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0]);
    expect(layout.rows.map((row) => row.laneCountAfter)).toEqual([0, 0]);
    expect(layout.rows[0]?.nodeColorId).not.toBe(layout.rows[1]?.nodeColorId);
  });

  it("keeps an unresolved parent open at a page boundary", () => {
    const layout = layoutGitHistoryGraph([commit(2, [1])]);

    expect(layout.rows[0]).toMatchObject({ laneCountBefore: 0, laneCountAfter: 1 });
    expect(segments(layout.rows[0]!, "outgoing")).toHaveLength(1);
  });

  it("does not alter earlier rows when an older page is appended", () => {
    const firstPage = [commit(3, [2])];
    const firstLayout = layoutGitHistoryGraph(firstPage);
    const appendedLayout = layoutGitHistoryGraph([...firstPage, commit(2, [1]), commit(1)]);

    expect(appendedLayout.rows[0]).toEqual(firstLayout.rows[0]);
    expect(segments(appendedLayout.rows[1]!, "incoming")[0]).toMatchObject({
      fromLane: 0,
      toLane: 0,
      colorId: firstLayout.rows[0]?.nodeColorId,
    });
  });

  it("reuses a closed lane without reusing the previous lineage color", () => {
    const layout = layoutGitHistoryGraph([commit(4, [3]), commit(3), commit(2, [1]), commit(1)]);

    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0, 0, 0]);
    expect(layout.rows[0]?.nodeColorId).toBe(layout.rows[1]?.nodeColorId);
    expect(layout.rows[2]?.nodeColorId).toBe(layout.rows[3]?.nodeColorId);
    expect(layout.rows[2]?.nodeColorId).not.toBe(layout.rows[0]?.nodeColorId);
  });

  it("marks HEAD without changing topology for branch or detached histories", () => {
    const commits = [commit(2, [1]), commit(1)];
    const branchHead = layoutGitHistoryGraph(commits, { headSha: sha(2) });
    const detachedHead = layoutGitHistoryGraph(commits, { headSha: sha(1) });

    expect(branchHead.rows.map((row) => row.isHead)).toEqual([true, false]);
    expect(detachedHead.rows.map((row) => row.isHead)).toEqual([false, true]);
    expect(branchHead.rows.map(({ isHead: _isHead, ...row }) => row)).toEqual(
      detachedHead.rows.map(({ isHead: _isHead, ...row }) => row),
    );
  });

  it("produces exactly one deterministic node descriptor per commit", () => {
    const commits = [commit(4, [3, 2]), commit(3, [1]), commit(2, [1]), commit(1)];

    const first = layoutGitHistoryGraph(commits);
    const second = layoutGitHistoryGraph(commits);

    expect(first).toEqual(second);
    expect(first.rows.map((row) => row.sha)).toEqual(commits.map(({ sha }) => sha));
  });
});
