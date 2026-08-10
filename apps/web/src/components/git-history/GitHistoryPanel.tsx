import { LegendList } from "@legendapp/list/react";
import {
  GIT_HISTORY_DEFAULT_LIMIT,
  type EnvironmentId,
  type GitHistoryCommitSummary,
  type GitHistoryRef,
  type GitListHistoryResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  appendGitHistoryPage,
  createEmptyGitHistoryAccumulation,
  replaceGitHistoryPage,
  type GitHistoryAccumulation,
  type GitHistoryTarget,
} from "@t3tools/client-runtime/state/git";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CloudIcon, GitBranchIcon, RefreshCwIcon, TagIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { parseTimestampDate } from "~/timestampFormat";

import { GitHistoryGraphCell, getGitHistoryGraphWidth } from "./GitHistoryGraphCell";
import { layoutGitHistoryGraph, type GitHistoryGraphRow } from "./gitHistoryGraphLayout";

const HISTORY_ROW_HEIGHT = 34;
const HISTORY_OVERSCAN_PX = HISTORY_ROW_HEIGHT * 4;
const SUBJECT_MIN_WIDTH = 80;
const AUTHOR_MIN_WIDTH = 64;
const DATE_COLUMN_WIDTH = 96;
const SHA_COLUMN_WIDTH = 76;
const ROW_END_PADDING = 8;
const HISTORY_VISIBLE_REF_LIMIT = 2;
const SKELETON_ROW_IDS = ["one", "two", "three", "four", "five", "six", "seven"] as const;
const HISTORY_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatHistoryDate(authoredAt: string): string {
  const date = parseTimestampDate(authoredAt);
  return date === null ? "—" : HISTORY_DATE_FORMATTER.format(date);
}

interface HistoryPanelLocalState {
  readonly targetKey: string;
  readonly history: GitHistoryAccumulation;
  readonly appliedFirstPage: GitListHistoryResult | null;
  readonly loadMoreError: string | null;
  readonly isLoadingMore: boolean;
}

function targetKey(target: GitHistoryTarget): string {
  return JSON.stringify([target.environmentId, target.projectId, target.threadId, target.cwd]);
}

function createLocalState(target: GitHistoryTarget): HistoryPanelLocalState {
  return {
    targetKey: targetKey(target),
    history: createEmptyGitHistoryAccumulation(target),
    appliedFirstPage: null,
    loadMoreError: null,
    isLoadingMore: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Git history request failed.";
}

export interface GitHistoryPanelViewProps {
  readonly commits: ReadonlyArray<GitHistoryCommitSummary>;
  readonly headSha: GitListHistoryResult["headSha"];
  readonly nextCursor: GitListHistoryResult["nextCursor"];
  readonly totalCount: GitListHistoryResult["totalCount"];
  readonly isInitialLoading: boolean;
  readonly initialError: string | null;
  readonly isRefreshing: boolean;
  readonly refreshError: string | null;
  readonly isLoadingMore: boolean;
  readonly loadMoreError: string | null;
  readonly onRefresh: () => void;
  readonly onLoadOlder: () => void;
}

interface GitHistoryCommitRowProps {
  readonly commit: GitHistoryCommitSummary;
  readonly graphRow: GitHistoryGraphRow;
  readonly graphLaneCount: number;
  readonly gridTemplateColumns: string;
}

export function GitHistoryShaButtonView({
  sha,
  isCopied,
  onCopy,
}: {
  readonly sha: string;
  readonly isCopied: boolean;
  readonly onCopy: (sha: string) => void;
}) {
  return (
    <button
      aria-label={isCopied ? `Copied commit SHA ${sha}` : `Copy full commit SHA ${sha}`}
      aria-live="polite"
      className="h-6 w-[68px] cursor-pointer rounded-sm text-left font-mono text-[11px] tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[copied=true]:text-primary"
      data-copied={isCopied}
      data-history-sha="true"
      onClick={() => onCopy(sha)}
      title={isCopied ? "Copied" : `Copy full SHA ${sha}`}
      type="button"
    >
      {isCopied ? "Copied" : sha.slice(0, 7)}
    </button>
  );
}

function GitHistoryShaButton({ sha }: { readonly sha: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "commit SHA",
    timeout: 1_200,
  });

  return (
    <GitHistoryShaButtonView
      isCopied={isCopied}
      onCopy={(value) => copyToClipboard(value)}
      sha={sha}
    />
  );
}

const HISTORY_REF_KIND_ORDER = {
  branch: 0,
  tag: 1,
  remote: 2,
} satisfies Record<GitHistoryRef["kind"], number>;

/** Produces the accessible and tooltip label shared by each ref presentation. */
function historyRefDescription(ref: GitHistoryRef): string {
  switch (ref.kind) {
    case "branch":
      return `Branch: ${ref.label}`;
    case "remote":
      return `Remote branch: ${ref.label}`;
    case "tag":
      return `Tag: ${ref.label}`;
  }
}

/** Maps each ref kind to the compact decorative icon used inside a ref pill. */
function GitHistoryRefIcon({ kind }: { readonly kind: GitHistoryRef["kind"] }) {
  const className = cn(
    "size-2.5 shrink-0",
    kind === "branch" && "text-primary/75",
    kind === "remote" && "text-info/75",
    kind === "tag" && "text-warning/80",
  );
  if (kind === "remote") return <CloudIcon aria-hidden="true" className={className} />;
  if (kind === "tag") return <TagIcon aria-hidden="true" className={className} />;
  return <GitBranchIcon aria-hidden="true" className={className} />;
}

/** Renders one labeled ref while preserving its full description in the tooltip. */
function GitHistoryRefPill({ reference }: { readonly reference: GitHistoryRef }) {
  return (
    <span
      className="inline-flex h-4 min-w-0 max-w-28 shrink items-center gap-0.5 rounded-sm border border-border/55 bg-muted/40 px-1 text-[10px] leading-none text-muted-foreground"
      data-history-ref-kind={reference.kind}
      title={historyRefDescription(reference)}
    >
      <GitHistoryRefIcon kind={reference.kind} />
      <span className="min-w-0 truncate">{reference.label}</span>
    </span>
  );
}

/** Sorts commit refs consistently and collapses additional refs into an overflow indicator. */
function GitHistoryCommitRefs({ refs }: { readonly refs: ReadonlyArray<GitHistoryRef> }) {
  if (refs.length === 0) return null;
  const orderedRefs = refs.toSorted(
    (left, right) =>
      HISTORY_REF_KIND_ORDER[left.kind] - HISTORY_REF_KIND_ORDER[right.kind] ||
      left.label.localeCompare(right.label),
  );
  const visibleRefs = orderedRefs.slice(0, HISTORY_VISIBLE_REF_LIMIT);
  const hiddenRefs = orderedRefs.slice(HISTORY_VISIBLE_REF_LIMIT);

  return (
    <span
      aria-hidden="true"
      className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap"
      data-history-refs="true"
    >
      {visibleRefs.map((reference) => (
        <GitHistoryRefPill key={`${reference.kind}:${reference.label}`} reference={reference} />
      ))}
      {hiddenRefs.length > 0 ? (
        <span
          className="inline-flex h-4 shrink-0 items-center rounded-sm border border-border/45 px-1 text-[10px] leading-none text-muted-foreground/70"
          data-history-ref-overflow="true"
          title={hiddenRefs.map(historyRefDescription).join("\n")}
        >
          +{hiddenRefs.length}
        </span>
      ) : null}
    </span>
  );
}

export function GitHistoryCommitRow({
  commit,
  graphRow,
  graphLaneCount,
  gridTemplateColumns,
}: GitHistoryCommitRowProps) {
  const subject = commit.subject || "(no subject)";
  const author = commit.authorName || "Unknown author";
  const authoredDate = formatHistoryDate(commit.authoredAt);
  const referenceDescriptions = commit.refs.map(historyRefDescription);
  const accessibleName = [
    graphRow.isHead ? "HEAD" : null,
    ...referenceDescriptions,
    subject,
    `${author} <${commit.authorEmail}>`,
    commit.authoredAt,
    `commit ${commit.sha}`,
  ]
    .filter((value) => value !== null)
    .join(", ");
  const tooltip = [
    graphRow.isHead ? "HEAD" : null,
    ...referenceDescriptions,
    subject,
    `${author} <${commit.authorEmail}>`,
    commit.authoredAt,
    commit.sha,
  ]
    .filter((value) => value !== null)
    .join("\n");

  return (
    <div
      aria-label={accessibleName}
      className="grid h-[34px] min-w-0 items-center border-b border-border/40 text-xs"
      data-history-row="true"
      role="listitem"
      style={{ gridTemplateColumns }}
      title={tooltip}
    >
      <GitHistoryGraphCell
        laneCount={graphLaneCount}
        row={graphRow}
        rowHeight={HISTORY_ROW_HEIGHT}
      />
      <div className="flex min-w-0 items-center gap-1.5 pe-2">
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground"
          data-history-subject="true"
        >
          {subject}
        </span>
        <GitHistoryCommitRefs refs={commit.refs} />
      </div>
      <span className="min-w-0 truncate pe-2 text-muted-foreground" data-history-author="true">
        {author}
      </span>
      <span
        className="min-w-0 truncate pe-2 text-[11px] tabular-nums text-muted-foreground"
        data-history-date="true"
      >
        {authoredDate}
      </span>
      <GitHistoryShaButton sha={commit.sha} />
    </div>
  );
}

function StaticHistorySkeleton() {
  return (
    <div aria-label="Loading commit history" className="p-2" role="status">
      {SKELETON_ROW_IDS.map((rowId) => (
        <div className="flex h-[34px] items-center gap-2 border-b border-border/30" key={rowId}>
          <span className="size-2 rounded-full bg-muted-foreground/20" />
          <span className="h-2.5 flex-1 rounded-sm bg-muted-foreground/15" />
          <span className="h-2.5 w-16 rounded-sm bg-muted-foreground/10" />
          <span className="h-2.5 w-20 rounded-sm bg-muted-foreground/10" />
          <span className="h-2.5 w-14 rounded-sm bg-muted-foreground/10" />
        </div>
      ))}
    </div>
  );
}

function HistoryStateMessage({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <div className="flex min-h-36 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm text-foreground">{title}</p>
      {detail ? <p className="max-w-sm text-xs text-muted-foreground">{detail}</p> : null}
      {action ? (
        <Button size="xs" variant="outline" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export function GitHistoryPanelView({
  commits,
  headSha,
  nextCursor,
  totalCount,
  isInitialLoading,
  initialError,
  isRefreshing,
  refreshError,
  isLoadingMore,
  loadMoreError,
  onRefresh,
  onLoadOlder,
}: GitHistoryPanelViewProps) {
  const layout = useMemo(() => layoutGitHistoryGraph(commits, { headSha }), [commits, headSha]);
  const rows = useMemo(
    () => commits.map((commit, index) => ({ commit, graphRow: layout.rows[index]! })),
    [commits, layout.rows],
  );
  const graphWidth = getGitHistoryGraphWidth(layout.maxLaneCount);
  const gridTemplateColumns = `${graphWidth}px minmax(${SUBJECT_MIN_WIDTH}px, 1fr) minmax(${AUTHOR_MIN_WIDTH}px, 0.34fr) ${DATE_COLUMN_WIDTH}px ${SHA_COLUMN_WIDTH}px`;
  const contentStyle = {
    minWidth:
      graphWidth +
      SUBJECT_MIN_WIDTH +
      AUTHOR_MIN_WIDTH +
      DATE_COLUMN_WIDTH +
      SHA_COLUMN_WIDTH +
      ROW_END_PADDING,
  } satisfies CSSProperties;
  const controlsPending = isInitialLoading || isRefreshing || isLoadingMore;
  const displayedCommitLabel =
    totalCount !== null
      ? `${totalCount.toLocaleString()} commit${totalCount === 1 ? "" : "s"}`
      : commits.length > 0
        ? `${commits.length.toLocaleString()}${nextCursor === null ? "" : "+"} commit${commits.length === 1 ? "" : "s"}`
        : "History";

  let content;
  if (isInitialLoading) {
    content = <StaticHistorySkeleton />;
  } else if (initialError !== null && commits.length === 0) {
    content = (
      <HistoryStateMessage
        action={{ label: "Retry", onClick: onRefresh }}
        detail={initialError}
        title="Could not load commit history."
      />
    );
  } else if (commits.length === 0) {
    content = <HistoryStateMessage title="No commits found." />;
  } else {
    content = (
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full flex-col" style={contentStyle}>
          <div
            aria-hidden="true"
            className="grid h-6 shrink-0 items-center border-b border-border/60 font-medium text-[10px] text-muted-foreground uppercase"
            style={{ gridTemplateColumns }}
          >
            <span />
            <span>Commit</span>
            <span>Author</span>
            <span>Date</span>
            <span>SHA</span>
          </div>
          {refreshError !== null ? (
            <div
              className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-2 py-1 text-xs text-destructive-foreground"
              role="alert"
            >
              <span className="min-w-0 flex-1 truncate">{refreshError}</span>
              <Button size="xs" variant="ghost" disabled={controlsPending} onClick={onRefresh}>
                Retry
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <LegendList<(typeof rows)[number]>
              className="h-full min-h-0 overscroll-y-contain"
              data={rows}
              drawDistance={HISTORY_OVERSCAN_PX}
              estimatedItemSize={HISTORY_ROW_HEIGHT}
              keyExtractor={(item) => item.commit.sha}
              renderItem={({ item }) => (
                <GitHistoryCommitRow
                  commit={item.commit}
                  graphLaneCount={layout.maxLaneCount}
                  graphRow={item.graphRow}
                  gridTemplateColumns={gridTemplateColumns}
                />
              )}
              role="list"
              style={{ height: "100%" }}
              ListFooterComponent={
                nextCursor !== null || loadMoreError !== null ? (
                  <div className="flex min-h-12 items-center justify-center gap-2 px-2 py-2">
                    {loadMoreError !== null ? (
                      <span className="min-w-0 truncate text-xs text-destructive-foreground">
                        {loadMoreError}
                      </span>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isLoadingMore || isRefreshing}
                      onClick={onLoadOlder}
                    >
                      {isLoadingMore
                        ? "Loading older commits…"
                        : loadMoreError !== null
                          ? "Retry"
                          : "Load older commits"}
                    </Button>
                  </div>
                ) : null
              }
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <section aria-label="Git commit history" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{displayedCommitLabel}</span>
        {isRefreshing ? (
          <span className="text-[11px] text-muted-foreground" role="status">
            Refreshing…
          </span>
        ) : null}
        <Button
          aria-label={isRefreshing ? "Refreshing history" : "Refresh history"}
          disabled={controlsPending}
          size="icon-xs"
          variant="ghost"
          onClick={onRefresh}
        >
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      {content}
    </section>
  );
}

export function GitHistoryPanel({
  environmentId,
  projectId,
  threadId,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly cwd: string;
}) {
  const target = useMemo<GitHistoryTarget>(
    () => ({ environmentId, projectId, threadId, cwd }),
    [cwd, environmentId, projectId, threadId],
  );
  const currentTargetKey = targetKey(target);
  const firstPage = useEnvironmentQuery(
    gitEnvironment.history({
      environmentId,
      input: {
        projectId,
        ...(threadId !== null ? { threadId } : {}),
        cwd,
        cursor: 0,
        limit: GIT_HISTORY_DEFAULT_LIMIT,
      },
    }),
  );
  const runHistoryPage = useAtomQueryRunner(gitEnvironment.history, {
    label: "load older Git history",
    reportFailure: false,
  });
  const [localState, setLocalState] = useState<HistoryPanelLocalState>(() =>
    createLocalState(target),
  );
  const activeTarget = useRef(target);
  activeTarget.current = target;
  const loadMoreFlight = useRef<{ readonly targetKey: string; readonly token: symbol } | null>(
    null,
  );
  const scopedState =
    localState.targetKey === currentTargetKey ? localState : createLocalState(target);
  const visibleHistory =
    firstPage.data !== null && scopedState.appliedFirstPage !== firstPage.data
      ? replaceGitHistoryPage(target, firstPage.data)
      : scopedState.history;

  useEffect(() => {
    setLocalState((current) => {
      const scoped = current.targetKey === currentTargetKey ? current : createLocalState(target);
      if (firstPage.data === null || scoped.appliedFirstPage === firstPage.data) return scoped;
      return {
        ...scoped,
        history: replaceGitHistoryPage(target, firstPage.data),
        appliedFirstPage: firstPage.data,
        loadMoreError: null,
        isLoadingMore: false,
      };
    });
  }, [currentTargetKey, firstPage.data, target]);

  const refresh = useCallback(() => {
    setLocalState((current) => {
      const scoped = current.targetKey === currentTargetKey ? current : createLocalState(target);
      return { ...scoped, loadMoreError: null };
    });
    firstPage.refresh();
  }, [currentTargetKey, firstPage, target]);

  const loadOlder = useCallback(() => {
    const cursor = visibleHistory.nextCursor;
    if (cursor === null || loadMoreFlight.current?.targetKey === currentTargetKey) return;

    const token = Symbol("git-history-page");
    loadMoreFlight.current = { targetKey: currentTargetKey, token };
    setLocalState((current) => {
      const scoped = current.targetKey === currentTargetKey ? current : createLocalState(target);
      return {
        ...scoped,
        history: visibleHistory,
        appliedFirstPage: firstPage.data,
        loadMoreError: null,
        isLoadingMore: true,
      };
    });

    void runHistoryPage({
      environmentId,
      input: {
        projectId,
        ...(threadId !== null ? { threadId } : {}),
        cwd,
        cursor,
        limit: GIT_HISTORY_DEFAULT_LIMIT,
      },
    }).then((result) => {
      if (activeTarget.current !== target) {
        if (loadMoreFlight.current?.token === token) loadMoreFlight.current = null;
        return;
      }
      setLocalState((current) => {
        if (current.targetKey !== currentTargetKey) return current;
        if (result._tag === "Success") {
          return {
            ...current,
            history: appendGitHistoryPage(current.history, target, result.value),
            loadMoreError: null,
            isLoadingMore: false,
          };
        }
        return {
          ...current,
          loadMoreError: errorMessage(squashAtomCommandFailure(result)),
          isLoadingMore: false,
        };
      });
      if (loadMoreFlight.current?.token === token) loadMoreFlight.current = null;
    });
  }, [
    currentTargetKey,
    cwd,
    environmentId,
    firstPage.data,
    projectId,
    runHistoryPage,
    target,
    threadId,
    visibleHistory,
  ]);

  const hasVisibleCommits = visibleHistory.commits.length > 0;
  return (
    <GitHistoryPanelView
      commits={visibleHistory.commits}
      headSha={visibleHistory.headSha}
      initialError={hasVisibleCommits ? null : firstPage.error}
      isInitialLoading={!hasVisibleCommits && firstPage.data === null && firstPage.error === null}
      isLoadingMore={scopedState.isLoadingMore}
      isRefreshing={hasVisibleCommits && firstPage.isPending}
      loadMoreError={scopedState.loadMoreError}
      nextCursor={visibleHistory.nextCursor}
      totalCount={visibleHistory.totalCount}
      refreshError={hasVisibleCommits ? firstPage.error : null}
      onLoadOlder={loadOlder}
      onRefresh={refresh}
    />
  );
}
