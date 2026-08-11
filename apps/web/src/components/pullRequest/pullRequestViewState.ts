import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import type { LoadedDiffSlice } from "@t3tools/client-runtime/state/paged-diff";

import type { DiffFoldOverride } from "./pullRequestDiff.logic";

export type PullRequestDetailTab = "summary" | "timeline" | "code";

export interface PullRequestScrollPosition {
  readonly top: number;
  readonly left: number;
}

export type PullRequestDiffSlice = LoadedDiffSlice;

export interface PullRequestCodeViewState {
  readonly foldOverride: DiffFoldOverride;
  readonly toggledFileKeys: ReadonlySet<string>;
  readonly slices: ReadonlyArray<PullRequestDiffSlice>;
}

export interface PullRequestViewStateEntry {
  readonly activeTab: PullRequestDetailTab;
  readonly timelineOrder: "newest" | "oldest";
  readonly selectedCommitOid: string | null;
  readonly chromeCondensedByTab: Partial<Record<PullRequestDetailTab, boolean>>;
  readonly scrollByView: Readonly<Record<string, PullRequestScrollPosition>>;
  readonly codeByScope: Readonly<Record<string, PullRequestCodeViewState>>;
}

// Code views retain their already-loaded patch slices so a deep scroll has content to return to.
// Keep the same conservative session bound as Git history, which retains accumulated rows too.
const MAX_REMEMBERED_PULL_REQUEST_VIEWS = 20;
const MAX_REMEMBERED_CODE_SCOPES_PER_PULL_REQUEST = 10;

const EMPTY_ENTRY: PullRequestViewStateEntry = {
  activeTab: "summary",
  timelineOrder: "newest",
  selectedCommitOid: null,
  chromeCondensedByTab: {},
  scrollByView: {},
  codeByScope: {},
};

function normalizedOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function cloneCodeView(state: PullRequestCodeViewState): PullRequestCodeViewState {
  return {
    foldOverride: state.foldOverride,
    toggledFileKeys: new Set(state.toggledFileKeys),
    slices: state.slices.map((slice) => ({ ...slice })),
  };
}

function cloneEntry(entry: PullRequestViewStateEntry): PullRequestViewStateEntry {
  return {
    ...entry,
    chromeCondensedByTab: { ...entry.chromeCondensedByTab },
    scrollByView: Object.fromEntries(
      Object.entries(entry.scrollByView).map(([key, position]) => [
        key,
        { top: normalizedOffset(position.top), left: normalizedOffset(position.left) },
      ]),
    ),
    codeByScope: Object.fromEntries(
      Object.entries(entry.codeByScope).map(([key, state]) => [key, cloneCodeView(state)]),
    ),
  };
}

export function pullRequestViewStateKey(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository,
    reference.number,
  ]);
}

export function pullRequestTabViewKey(
  tab: PullRequestDetailTab,
  selectedCommitOid: string | null = null,
): string {
  return tab === "code" ? `code:${selectedCommitOid ?? "all"}` : tab;
}

export function pullRequestCodeScopeKey(selectedCommitOid: string | null): string {
  return selectedCommitOid ?? "all";
}

export function createPullRequestViewStateMemory(maxEntries = MAX_REMEMBERED_PULL_REQUEST_VIEWS) {
  const entries = new Map<string, PullRequestViewStateEntry>();
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;

  const write = (key: string, entry: PullRequestViewStateEntry): void => {
    entries.delete(key);
    entries.set(key, cloneEntry(entry));
    if (entries.size <= limit) return;
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  };
  const current = (key: string): PullRequestViewStateEntry => entries.get(key) ?? EMPTY_ENTRY;

  return {
    get(key: string): PullRequestViewStateEntry | null {
      const entry = entries.get(key);
      if (!entry) return null;
      write(key, entry);
      return cloneEntry(entry);
    },
    rememberPanel(
      key: string,
      panel: Pick<PullRequestViewStateEntry, "activeTab" | "timelineOrder" | "selectedCommitOid">,
    ): void {
      write(key, { ...current(key), ...panel });
    },
    rememberChrome(key: string, tab: PullRequestDetailTab, chromeCondensed: boolean): void {
      const entry = current(key);
      write(key, {
        ...entry,
        chromeCondensedByTab: { ...entry.chromeCondensedByTab, [tab]: chromeCondensed },
      });
    },
    rememberScroll(key: string, viewKey: string, position: PullRequestScrollPosition): void {
      const entry = current(key);
      write(key, {
        ...entry,
        scrollByView: {
          ...entry.scrollByView,
          [viewKey]: {
            top: normalizedOffset(position.top),
            left: normalizedOffset(position.left),
          },
        },
      });
    },
    rememberCode(key: string, scopeKey: string, state: PullRequestCodeViewState): void {
      const entry = current(key);
      const codeByScope = { ...entry.codeByScope };
      delete codeByScope[scopeKey];
      codeByScope[scopeKey] = cloneCodeView(state);
      const oldestScopeKey = Object.keys(codeByScope).at(
        -1 - MAX_REMEMBERED_CODE_SCOPES_PER_PULL_REQUEST,
      );
      if (oldestScopeKey !== undefined) delete codeByScope[oldestScopeKey];
      write(key, {
        ...entry,
        codeByScope,
      });
    },
    get size(): number {
      return entries.size;
    },
  };
}

const pullRequestViewStateMemory = createPullRequestViewStateMemory();

export function getPullRequestViewState(key: string): PullRequestViewStateEntry | null {
  return pullRequestViewStateMemory.get(key);
}

export function rememberPullRequestPanelState(
  key: string,
  panel: Pick<PullRequestViewStateEntry, "activeTab" | "timelineOrder" | "selectedCommitOid">,
): void {
  pullRequestViewStateMemory.rememberPanel(key, panel);
}

export function rememberPullRequestChromeState(
  key: string,
  tab: PullRequestDetailTab,
  chromeCondensed: boolean,
): void {
  pullRequestViewStateMemory.rememberChrome(key, tab, chromeCondensed);
}

export function getPullRequestScrollPosition(
  key: string,
  viewKey: string,
): PullRequestScrollPosition | null {
  return getPullRequestViewState(key)?.scrollByView[viewKey] ?? null;
}

export function rememberPullRequestScrollPosition(
  key: string,
  viewKey: string,
  position: PullRequestScrollPosition,
): void {
  pullRequestViewStateMemory.rememberScroll(key, viewKey, position);
}

export function getPullRequestCodeViewState(
  key: string,
  scopeKey: string,
): PullRequestCodeViewState | null {
  return getPullRequestViewState(key)?.codeByScope[scopeKey] ?? null;
}

export function rememberPullRequestCodeViewState(
  key: string,
  scopeKey: string,
  state: PullRequestCodeViewState,
): void {
  pullRequestViewStateMemory.rememberCode(key, scopeKey, state);
}
