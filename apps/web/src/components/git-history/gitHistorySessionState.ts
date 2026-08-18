import type { GitHistoryAccumulation, GitHistoryTarget } from "@t3tools/client-runtime/state/git";
import type { GitListHistoryResult } from "@t3tools/contracts";

export interface GitHistorySessionEntry {
  readonly history: GitHistoryAccumulation | null;
  readonly appliedFirstPage: GitListHistoryResult | null;
  readonly scrollOffset: number | null;
  readonly showOnlyTips: boolean;
}

const MAX_REMEMBERED_GIT_HISTORY_TARGETS = 20;

function normalizeScrollOffset(offset: number): number {
  return Number.isFinite(offset) ? Math.max(0, offset) : 0;
}

export function gitHistorySessionKey(target: GitHistoryTarget): string {
  return JSON.stringify([target.environmentId, target.projectId, target.threadId, target.cwd]);
}

export function createGitHistorySessionMemory(maxEntries = MAX_REMEMBERED_GIT_HISTORY_TARGETS) {
  const entries = new Map<string, GitHistorySessionEntry>();
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;

  const write = (key: string, entry: GitHistorySessionEntry): void => {
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size <= limit) return;
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  };

  return {
    get(key: string): GitHistorySessionEntry | null {
      const entry = entries.get(key);
      if (!entry) return null;
      write(key, entry);
      return entry;
    },
    rememberHistory(
      key: string,
      history: GitHistoryAccumulation,
      appliedFirstPage: GitListHistoryResult | null,
    ): void {
      const current = entries.get(key);
      write(key, {
        history,
        appliedFirstPage,
        scrollOffset: current?.scrollOffset ?? null,
        showOnlyTips: current?.showOnlyTips ?? false,
      });
    },
    rememberScroll(key: string, scrollOffset: number): void {
      const current = entries.get(key);
      write(key, {
        history: current?.history ?? null,
        appliedFirstPage: current?.appliedFirstPage ?? null,
        scrollOffset: normalizeScrollOffset(scrollOffset),
        showOnlyTips: current?.showOnlyTips ?? false,
      });
    },
    rememberShowOnlyTips(key: string, showOnlyTips: boolean): void {
      const current = entries.get(key);
      write(key, {
        history: current?.history ?? null,
        appliedFirstPage: current?.appliedFirstPage ?? null,
        scrollOffset: current?.scrollOffset ?? null,
        showOnlyTips,
      });
    },
    get size(): number {
      return entries.size;
    },
  };
}

const gitHistorySessionMemory = createGitHistorySessionMemory();

export function getGitHistorySession(key: string): GitHistorySessionEntry | null {
  return gitHistorySessionMemory.get(key);
}

export function rememberGitHistorySession(
  key: string,
  history: GitHistoryAccumulation,
  appliedFirstPage: GitListHistoryResult | null,
): void {
  gitHistorySessionMemory.rememberHistory(key, history, appliedFirstPage);
}

export function rememberGitHistoryScroll(key: string, scrollOffset: number): void {
  gitHistorySessionMemory.rememberScroll(key, scrollOffset);
}

export function rememberGitHistoryShowOnlyTips(key: string, showOnlyTips: boolean): void {
  gitHistorySessionMemory.rememberShowOnlyTips(key, showOnlyTips);
}
