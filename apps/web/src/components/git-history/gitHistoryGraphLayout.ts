import type { GitHistoryCommitSummary, GitObjectId } from "@t3tools/contracts";

export type GitHistoryGraphSegmentShape = "through" | "incoming" | "outgoing";

export interface GitHistoryGraphSegment {
  readonly fromLane: number;
  readonly toLane: number;
  readonly colorId: number;
  readonly shape: GitHistoryGraphSegmentShape;
}

export interface GitHistoryGraphRow {
  readonly sha: GitObjectId;
  readonly nodeLane: number;
  readonly nodeColorId: number;
  readonly laneCountBefore: number;
  readonly laneCountAfter: number;
  readonly segments: ReadonlyArray<GitHistoryGraphSegment>;
  readonly isHead: boolean;
}

export interface GitHistoryGraphLayout {
  readonly rows: ReadonlyArray<GitHistoryGraphRow>;
  readonly maxLaneCount: number;
}

export interface GitHistoryGraphLayoutOptions {
  readonly headSha?: GitObjectId | null;
}

interface ActiveLane {
  readonly id: number;
  readonly colorId: number;
  readonly targetSha: GitObjectId;
}

interface OutgoingEdge {
  readonly laneId: number;
  readonly colorId: number;
}

function laneIndexById(lanes: ReadonlyArray<ActiveLane>, laneId: number): number {
  const index = lanes.findIndex((lane) => lane.id === laneId);
  if (index === -1) throw new Error(`Missing active Git history lane ${laneId}`);
  return index;
}

/**
 * Lays out commits ordered with children before parents, as produced by Git's
 * topological history order. Recomputing with older pages appended preserves
 * every descriptor in the already-loaded prefix.
 */
export function layoutGitHistoryGraph(
  commits: ReadonlyArray<GitHistoryCommitSummary>,
  options: GitHistoryGraphLayoutOptions = {},
): GitHistoryGraphLayout {
  let activeLanes: ReadonlyArray<ActiveLane> = [];
  let nextLaneId = 0;
  let nextColorId = 0;
  let maxLaneCount = 0;
  const rows: Array<GitHistoryGraphRow> = [];

  for (const commit of commits) {
    const lanesBefore = activeLanes;
    const incomingLaneIndexes: Array<number> = [];

    for (let index = 0; index < lanesBefore.length; index += 1) {
      if (lanesBefore[index]?.targetSha === commit.sha) incomingLaneIndexes.push(index);
    }

    const primaryIncomingIndex = incomingLaneIndexes[0];
    const nodeLane = primaryIncomingIndex ?? lanesBefore.length;
    const primaryIncomingLane =
      primaryIncomingIndex === undefined ? undefined : lanesBefore[primaryIncomingIndex];
    const nodeColorId = primaryIncomingLane?.colorId ?? nextColorId++;
    const resolvedLaneIds = new Set(
      incomingLaneIndexes.map((index) => lanesBefore[index]?.id).filter((id) => id !== undefined),
    );
    const nextLanes = lanesBefore.filter((lane) => !resolvedLaneIds.has(lane.id));
    const outgoingEdges: Array<OutgoingEdge> = [];

    const firstParentSha = commit.parentShas[0];
    let primaryOutgoingLaneId: number | undefined;
    if (firstParentSha !== undefined) {
      const primaryLane: ActiveLane = {
        id: primaryIncomingLane?.id ?? nextLaneId++,
        colorId: nodeColorId,
        targetSha: firstParentSha,
      };
      const insertionIndex = Math.min(nodeLane, nextLanes.length);
      nextLanes.splice(insertionIndex, 0, primaryLane);
      primaryOutgoingLaneId = primaryLane.id;
      outgoingEdges.push({ laneId: primaryLane.id, colorId: primaryLane.colorId });
    }

    let newParentOffset = 1;
    for (const parentSha of commit.parentShas.slice(1)) {
      const existingLane = nextLanes.find((lane) => lane.targetSha === parentSha);
      if (existingLane !== undefined) {
        outgoingEdges.push({ laneId: existingLane.id, colorId: existingLane.colorId });
        continue;
      }

      const parentLane: ActiveLane = {
        id: nextLaneId++,
        colorId: nextColorId++,
        targetSha: parentSha,
      };
      const primaryIndex =
        primaryOutgoingLaneId === undefined
          ? Math.min(nodeLane, nextLanes.length)
          : laneIndexById(nextLanes, primaryOutgoingLaneId);
      nextLanes.splice(primaryIndex + newParentOffset, 0, parentLane);
      newParentOffset += 1;
      outgoingEdges.push({ laneId: parentLane.id, colorId: parentLane.colorId });
    }

    const incomingSegments = incomingLaneIndexes.map((fromLane) => ({
      fromLane,
      toLane: nodeLane,
      colorId: lanesBefore[fromLane]?.colorId ?? nodeColorId,
      shape: "incoming" as const,
    }));
    const throughSegments = lanesBefore.flatMap((lane, fromLane) =>
      resolvedLaneIds.has(lane.id)
        ? []
        : [
            {
              fromLane,
              toLane: laneIndexById(nextLanes, lane.id),
              colorId: lane.colorId,
              shape: "through" as const,
            },
          ],
    );
    const outgoingSegments = outgoingEdges.map((edge) => ({
      fromLane: nodeLane,
      toLane: laneIndexById(nextLanes, edge.laneId),
      colorId: edge.colorId,
      shape: "outgoing" as const,
    }));

    const laneCountBefore = lanesBefore.length;
    const laneCountAfter = nextLanes.length;
    maxLaneCount = Math.max(maxLaneCount, laneCountBefore, laneCountAfter, nodeLane + 1);
    rows.push({
      sha: commit.sha,
      nodeLane,
      nodeColorId,
      laneCountBefore,
      laneCountAfter,
      segments: [...throughSegments, ...incomingSegments, ...outgoingSegments],
      isHead: commit.sha === options.headSha,
    });
    activeLanes = nextLanes;
  }

  return { rows, maxLaneCount };
}
