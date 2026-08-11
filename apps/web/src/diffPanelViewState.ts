import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

export interface DiffPanelScrollPosition {
  readonly top: number;
  readonly left: number;
}

export interface DiffPanelViewStateEntry {
  readonly collapsedFileKeys: ReadonlySet<string>;
  readonly scrollPosition: DiffPanelScrollPosition | null;
  readonly revealRequestId: number | null;
}

const MAX_REMEMBERED_DIFF_PANEL_VIEWS = 100;

function normalizedOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedRevealRequestId(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cloneEntry(entry: DiffPanelViewStateEntry): DiffPanelViewStateEntry {
  return {
    collapsedFileKeys: new Set(entry.collapsedFileKeys),
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
      collapsedFileKeys: new Set(),
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
    rememberCollapsedFileKeys(key: string, fileKeys: ReadonlySet<string>): void {
      write(key, { ...currentOrEmpty(key), collapsedFileKeys: fileKeys });
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

export function rememberDiffPanelCollapsedFileKeys(
  key: string,
  fileKeys: ReadonlySet<string>,
): void {
  diffPanelViewStateMemory.rememberCollapsedFileKeys(key, fileKeys);
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
