import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoadedDiffSlice } from "@t3tools/client-runtime/state/paged-diff";
import type { ReviewDiffPreviewSource, ScopedThreadRef } from "@t3tools/contracts";

import type { DiffFoldOverride } from "~/lib/diffCollapse";

export interface DiffPanelScrollPosition {
  readonly top: number;
  readonly left: number;
}

export interface DiffPanelViewStateEntry {
  readonly foldOverride: DiffFoldOverride;
  readonly toggledFileKeys: ReadonlySet<string>;
  readonly pagedDiff: {
    readonly scopeKey: string;
    readonly slices: ReadonlyArray<LoadedDiffSlice>;
    readonly source: ReviewDiffPreviewSource | null;
    readonly legacy: boolean;
  } | null;
  readonly scrollPosition: DiffPanelScrollPosition | null;
  readonly revealRequestId: number | null;
}

// Paged views retain patch slices so a deep scroll has content to return to after a tab remount.
const MAX_REMEMBERED_DIFF_PANEL_VIEWS = 20;

function normalizedOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedRevealRequestId(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cloneEntry(entry: DiffPanelViewStateEntry): DiffPanelViewStateEntry {
  return {
    foldOverride: entry.foldOverride,
    toggledFileKeys: new Set(entry.toggledFileKeys),
    pagedDiff: entry.pagedDiff
      ? {
          ...entry.pagedDiff,
          slices: entry.pagedDiff.slices.map((slice) => ({ ...slice })),
          source: entry.pagedDiff.source ? { ...entry.pagedDiff.source } : null,
        }
      : null,
    scrollPosition: entry.scrollPosition
      ? {
          top: normalizedOffset(entry.scrollPosition.top),
          left: normalizedOffset(entry.scrollPosition.left),
        }
      : null,
    revealRequestId: normalizedRevealRequestId(entry.revealRequestId),
  };
}

export function diffPanelViewStateKey(ref: ScopedThreadRef, sectionId: string): string {
  return JSON.stringify([scopedThreadKey(ref), sectionId]);
}

export function createDiffPanelViewStateMemory(maxEntries = MAX_REMEMBERED_DIFF_PANEL_VIEWS) {
  const entries = new Map<string, DiffPanelViewStateEntry>();
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;

  const write = (key: string, entry: DiffPanelViewStateEntry): void => {
    entries.delete(key);
    entries.set(key, cloneEntry(entry));
    if (entries.size <= limit) return;
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  };

  const currentOrEmpty = (key: string): DiffPanelViewStateEntry =>
    entries.get(key) ?? {
      foldOverride: null,
      toggledFileKeys: new Set(),
      pagedDiff: null,
      scrollPosition: null,
      revealRequestId: null,
    };

  return {
    get(key: string): DiffPanelViewStateEntry | null {
      const entry = entries.get(key);
      if (!entry) return null;
      write(key, entry);
      return cloneEntry(entry);
    },
    rememberFoldState(
      key: string,
      foldOverride: DiffFoldOverride,
      toggledFileKeys: ReadonlySet<string>,
    ): void {
      write(key, { ...currentOrEmpty(key), foldOverride, toggledFileKeys });
    },
    rememberPagedDiff(
      key: string,
      pagedDiff: NonNullable<DiffPanelViewStateEntry["pagedDiff"]>,
    ): void {
      write(key, { ...currentOrEmpty(key), pagedDiff });
    },
    rememberScrollPosition(key: string, scrollPosition: DiffPanelScrollPosition): void {
      write(key, { ...currentOrEmpty(key), scrollPosition });
    },
    rememberRevealRequest(key: string, revealRequestId: number): void {
      write(key, { ...currentOrEmpty(key), revealRequestId });
    },
    get size(): number {
      return entries.size;
    },
  };
}

const diffPanelViewStateMemory = createDiffPanelViewStateMemory();

export function getDiffPanelViewState(key: string): DiffPanelViewStateEntry | null {
  return diffPanelViewStateMemory.get(key);
}

export function rememberDiffPanelFoldState(
  key: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): void {
  diffPanelViewStateMemory.rememberFoldState(key, foldOverride, toggledFileKeys);
}

export function rememberDiffPanelPagedDiff(
  key: string,
  pagedDiff: NonNullable<DiffPanelViewStateEntry["pagedDiff"]>,
): void {
  diffPanelViewStateMemory.rememberPagedDiff(key, pagedDiff);
}

export function rememberDiffPanelScrollPosition(
  key: string,
  scrollPosition: DiffPanelScrollPosition,
): void {
  diffPanelViewStateMemory.rememberScrollPosition(key, scrollPosition);
}

export function rememberDiffPanelRevealRequest(key: string, revealRequestId: number): void {
  diffPanelViewStateMemory.rememberRevealRequest(key, revealRequestId);
}

export function shouldRestoreDiffPanelScroll(
  entry: DiffPanelViewStateEntry | null,
  revealRequestId: number | null,
): entry is DiffPanelViewStateEntry & { scrollPosition: DiffPanelScrollPosition } {
  return (
    entry !== null &&
    entry.scrollPosition !== null &&
    (revealRequestId === null || entry.revealRequestId === revealRequestId)
  );
}

export function isDiffPanelRevealRequestHandled(
  entry: DiffPanelViewStateEntry | null,
  revealRequestId: number,
): boolean {
  return entry?.revealRequestId === revealRequestId;
}
