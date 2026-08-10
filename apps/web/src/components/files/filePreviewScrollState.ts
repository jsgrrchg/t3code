import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

export type FilePreviewScrollMode = "source" | "markdown" | "image";

export interface FilePreviewScrollPosition {
  readonly top: number;
  readonly left: number;
}

export interface FilePreviewScrollEntry {
  readonly position: FilePreviewScrollPosition;
  readonly revealRequestId: number | null;
}

interface FilePreviewScrollIdentity {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly mode: FilePreviewScrollMode;
}

const MAX_REMEMBERED_FILE_PREVIEW_SCROLL_ENTRIES = 200;

function normalizedOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedRevealRequestId(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cloneEntry(entry: FilePreviewScrollEntry): FilePreviewScrollEntry {
  return {
    position: {
      top: normalizedOffset(entry.position.top),
      left: normalizedOffset(entry.position.left),
    },
    revealRequestId: normalizedRevealRequestId(entry.revealRequestId),
  };
}

export function filePreviewScrollKey(identity: FilePreviewScrollIdentity): string {
  return JSON.stringify([
    scopedThreadKey(identity.threadRef),
    identity.cwd,
    identity.relativePath,
    identity.mode,
  ]);
}

export function createFilePreviewScrollMemory(
  maxEntries = MAX_REMEMBERED_FILE_PREVIEW_SCROLL_ENTRIES,
) {
  const entries = new Map<string, FilePreviewScrollEntry>();
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;

  return {
    get(key: string): FilePreviewScrollEntry | null {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return cloneEntry(entry);
    },
    set(key: string, entry: FilePreviewScrollEntry): void {
      entries.delete(key);
      entries.set(key, cloneEntry(entry));
      if (entries.size <= limit) return;
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    },
    get size(): number {
      return entries.size;
    },
  };
}

const filePreviewScrollMemory = createFilePreviewScrollMemory();

export function getRememberedFilePreviewScroll(key: string): FilePreviewScrollEntry | null {
  return filePreviewScrollMemory.get(key);
}

export function rememberFilePreviewScroll(key: string, entry: FilePreviewScrollEntry): void {
  filePreviewScrollMemory.set(key, entry);
}

export function shouldRestoreFilePreviewScroll(
  entry: FilePreviewScrollEntry | null,
  revealRequestId?: number,
): entry is FilePreviewScrollEntry {
  return (
    entry !== null && (revealRequestId === undefined || entry.revealRequestId === revealRequestId)
  );
}

export function resolveFilePreviewRevealRequestId(
  entry: FilePreviewScrollEntry | null,
  revealRequestId: number | null,
  restoreForRevealRequestId?: number,
): number | null {
  if (restoreForRevealRequestId === undefined) return revealRequestId;
  // A source reveal is only consumed after useFileLineReveal writes it into
  // the cache. Preserve the previous marker if this mount ended before that.
  return entry?.revealRequestId === restoreForRevealRequestId
    ? restoreForRevealRequestId
    : (entry?.revealRequestId ?? null);
}
