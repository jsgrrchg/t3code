import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";

import type { GitHistoryGraphRow, GitHistoryGraphSegment } from "./gitHistoryGraphLayout";

export const GIT_HISTORY_GRAPH_ROW_HEIGHT = 36;
export const GIT_HISTORY_GRAPH_LANE_SPACING = 12;
export const GIT_HISTORY_GRAPH_NODE_RADIUS = 3.25;
export const GIT_HISTORY_GRAPH_STROKE_WIDTH = 1.5;

const GRAPH_SIDE_PADDING = 5;
const GRAPH_ROW_OVERLAP = 0.75;
const LANE_COLORS = [
  "var(--primary)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--destructive)",
  "color-mix(in srgb, var(--foreground) 72%, var(--primary))",
] as const;

function laneX(lane: number): number {
  return GRAPH_SIDE_PADDING + GIT_HISTORY_GRAPH_NODE_RADIUS + lane * GIT_HISTORY_GRAPH_LANE_SPACING;
}

function segmentPath(segment: GitHistoryGraphSegment, rowHeight: number): string {
  const fromX = laneX(segment.fromLane);
  const toX = laneX(segment.toLane);
  const middleY = rowHeight / 2;

  if (segment.shape === "incoming") {
    return `M ${fromX} ${-GRAPH_ROW_OVERLAP} C ${fromX} ${middleY * 0.55}, ${toX} ${middleY * 0.55}, ${toX} ${middleY}`;
  }
  if (segment.shape === "outgoing") {
    return `M ${fromX} ${middleY} C ${fromX} ${middleY * 1.45}, ${toX} ${middleY * 1.45}, ${toX} ${rowHeight + GRAPH_ROW_OVERLAP}`;
  }
  return `M ${fromX} ${-GRAPH_ROW_OVERLAP} C ${fromX} ${middleY}, ${toX} ${middleY}, ${toX} ${rowHeight + GRAPH_ROW_OVERLAP}`;
}

function colorForId(colorId: number): string {
  return LANE_COLORS[colorId % LANE_COLORS.length] ?? LANE_COLORS[0];
}

export function getGitHistoryGraphWidth(laneCount: number): number {
  const renderedLaneCount = Math.max(1, laneCount);
  return (
    GRAPH_SIDE_PADDING * 2 +
    GIT_HISTORY_GRAPH_NODE_RADIUS * 2 +
    (renderedLaneCount - 1) * GIT_HISTORY_GRAPH_LANE_SPACING
  );
}

interface GitHistoryGraphCellProps {
  readonly row: GitHistoryGraphRow;
  readonly laneCount: number;
  readonly rowHeight?: number;
  readonly className?: string;
}

export function GitHistoryGraphCell({
  row,
  laneCount,
  rowHeight = GIT_HISTORY_GRAPH_ROW_HEIGHT,
  className,
}: GitHistoryGraphCellProps) {
  const width = getGitHistoryGraphWidth(laneCount);
  const style = { width, height: rowHeight } satisfies CSSProperties;

  return (
    <svg
      aria-hidden="true"
      className={cn("pointer-events-none block shrink-0 overflow-visible", className)}
      focusable="false"
      style={style}
      viewBox={`0 0 ${width} ${rowHeight}`}
    >
      {row.segments.map((segment) => (
        <path
          key={`${row.sha}:${segment.shape}:${segment.fromLane}:${segment.toLane}:${segment.colorId}`}
          d={segmentPath(segment, rowHeight)}
          fill="none"
          stroke={colorForId(segment.colorId)}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={GIT_HISTORY_GRAPH_STROKE_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {row.isHead ? (
        <circle
          cx={laneX(row.nodeLane)}
          cy={rowHeight / 2}
          fill="var(--background)"
          r={GIT_HISTORY_GRAPH_NODE_RADIUS + 2.25}
          stroke={colorForId(row.nodeColorId)}
          strokeWidth={GIT_HISTORY_GRAPH_STROKE_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <circle
        cx={laneX(row.nodeLane)}
        cy={rowHeight / 2}
        fill={colorForId(row.nodeColorId)}
        r={GIT_HISTORY_GRAPH_NODE_RADIUS}
      />
    </svg>
  );
}
