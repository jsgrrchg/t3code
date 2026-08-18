import type { GitHistoryCommitSummary } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ commit: GitHistoryCommitSummary }>;
    drawDistance: number;
    estimatedItemSize: number;
    keyExtractor: (item: { commit: GitHistoryCommitSummary }) => string;
    renderItem: (args: { item: { commit: GitHistoryCommitSummary } }) => ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div
      data-draw-distance={props.drawDistance}
      data-estimated-size={props.estimatedItemSize}
      data-total-count={props.data.length}
      data-testid="history-legend-list"
    >
      {props.data.slice(0, 4).map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));

import {
  GitHistoryCommitRow,
  GitHistoryPanelView,
  GitHistoryShaButtonView,
  type GitHistoryPanelViewProps,
} from "./GitHistoryPanel";
import { layoutGitHistoryGraph } from "./gitHistoryGraphLayout";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GRID_TEMPLATE_COLUMNS = "17px minmax(80px, 1fr) minmax(64px, 0.34fr) 96px 76px";

function commit(
  sha = HEAD_SHA,
  subject = "Render history rows",
  authorName = "Ada Lovelace",
  refs: GitHistoryCommitSummary["refs"] = [],
): GitHistoryCommitSummary {
  return {
    sha,
    parentShas: [],
    subject,
    authorName,
    authorEmail: "ada@example.com",
    authoredAt: "2026-08-10T12:34:56Z",
    refs,
  };
}

const baseProps: GitHistoryPanelViewProps = {
  commits: [commit()],
  branchTips: undefined,
  headSha: HEAD_SHA,
  nextCursor: null,
  totalCount: 1,
  comparison: undefined,
  isInitialLoading: false,
  initialError: null,
  isRefreshing: false,
  refreshError: null,
  isLoadingMore: false,
  loadMoreError: null,
  canFetchAll: true,
  isFetching: false,
  fetchError: null,
  showOnlyTips: false,
  scrollKey: "history-target",
  initialScrollOffset: null,
  onRefresh: () => {},
  onFetchAll: () => {},
  onShowOnlyTipsChange: () => {},
  onLoadOlder: () => {},
  onScrollOffsetChange: () => {},
  onOpenCommit: () => {},
};

function renderView(overrides: Partial<GitHistoryPanelViewProps> = {}): string {
  return renderToStaticMarkup(<GitHistoryPanelView {...baseProps} {...overrides} />);
}

function buttonTagBefore(markup: string, text: string): string {
  const textIndex = markup.indexOf(text);
  const start = markup.lastIndexOf("<button", textIndex);
  const end = markup.indexOf(">", start);
  return markup.slice(start, end + 1);
}

describe("GitHistoryCommitRow", () => {
  it("renders graph, subject, author, date, and short SHA in that order", () => {
    const item = commit();
    const graph = layoutGitHistoryGraph([item], { headSha: item.sha });
    const markup = renderToStaticMarkup(
      <GitHistoryCommitRow
        commit={item}
        graphLaneCount={graph.maxLaneCount}
        graphRow={graph.rows[0]!}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
      />,
    );

    const graphIndex = markup.indexOf("<svg");
    const subjectIndex = markup.indexOf('data-history-subject="true"');
    const authorIndex = markup.indexOf('data-history-author="true"');
    const dateIndex = markup.indexOf('data-history-date="true"');
    const shaIndex = markup.indexOf('data-history-sha="true"');
    expect(graphIndex).toBeLessThan(subjectIndex);
    expect(subjectIndex).toBeLessThan(authorIndex);
    expect(authorIndex).toBeLessThan(dateIndex);
    expect(dateIndex).toBeLessThan(shaIndex);
    expect(markup).toContain(item.subject);
    expect(markup).toContain(item.authorName);
    expect(markup).toContain(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(item.authoredAt)),
    );
    expect(markup).toContain(item.sha.slice(0, 7));
    expect(markup).toContain(`aria-label="Copy full commit SHA ${item.sha}"`);
    expect(markup).toContain(`aria-label="Open commit ${item.sha} diff in new tab"`);
    const openCommitButton = buttonTagBefore(markup, `Open commit ${item.sha} diff in new tab`);
    expect(openCommitButton).toContain("hover:bg-accent");
    expect(openCommitButton).toContain("hover:[--control-icon-color:var(--foreground)]");
    expect(markup).toContain("<button");
  });

  it("announces full metadata and HEAD while keeping the graph decorative", () => {
    const item = commit();
    const graph = layoutGitHistoryGraph([item], { headSha: item.sha });
    const markup = renderToStaticMarkup(
      <GitHistoryCommitRow
        commit={item}
        graphLaneCount={graph.maxLaneCount}
        graphRow={graph.rows[0]!}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
      />,
    );

    expect(markup).toContain("HEAD, Render history rows");
    expect(markup).toContain("ada@example.com");
    expect(markup).toContain("2026-08-10T12:34:56Z");
    expect(markup).toContain(HEAD_SHA);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('role="listitem"');
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup.match(/<circle/g)).toHaveLength(2);
  });

  it("keeps truncatable subject and author columns alongside fixed date and SHA columns", () => {
    const item = commit(HEAD_SHA, "A very long subject that must truncate", "A very long author");
    const graph = layoutGitHistoryGraph([item]);
    const markup = renderToStaticMarkup(
      <GitHistoryCommitRow
        commit={item}
        graphLaneCount={graph.maxLaneCount}
        graphRow={graph.rows[0]!}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
      />,
    );

    expect(markup).toContain("minmax(80px, 1fr)");
    expect(markup).toContain("minmax(64px, 0.34fr)");
    expect(markup).toContain('data-history-subject="true"');
    expect(markup).toContain('data-history-author="true"');
    expect(markup).toContain('data-history-date="true"');
    expect(markup).toContain('data-history-sha="true"');
    expect(markup.match(/truncate/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("shows compact refs with app tooltips without growing or wrapping the row", () => {
    const item = commit(HEAD_SHA, "Keep history dense", "Ada Lovelace", [
      { kind: "remote", label: "upstream/feature/very-long-remote-name" },
      { kind: "tag", label: "v1.2.3" },
      { kind: "branch", label: "feature/history" },
      { kind: "remote", label: "origin/feature/history" },
    ]);
    const graph = layoutGitHistoryGraph([item], { headSha: item.sha });
    const markup = renderToStaticMarkup(
      <GitHistoryCommitRow
        commit={item}
        graphLaneCount={graph.maxLaneCount}
        graphRow={graph.rows[0]!}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
      />,
    );

    const branchIndex = markup.indexOf('data-history-ref-kind="branch"');
    const tagIndex = markup.indexOf('data-history-ref-kind="tag"');
    const subjectIndex = markup.indexOf('data-history-subject="true"');
    expect(branchIndex).toBeGreaterThan(-1);
    expect(subjectIndex).toBeLessThan(branchIndex);
    expect(branchIndex).toBeLessThan(tagIndex);
    expect(markup).not.toContain('data-history-ref-kind="remote"');
    expect(markup).toContain('data-history-ref-overflow="true"');
    expect(markup).toContain(">+2</span>");
    expect(markup).toContain("Remote branch: origin/feature/history");
    expect(markup).toContain("Remote branch: upstream/feature/very-long-remote-name");
    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(3);
    expect(markup.match(/title=""/g)).toHaveLength(3);
    expect(markup).toContain("h-[34px]");
    expect(markup).toContain("h-4");
    expect(markup.match(/<button/g)).toHaveLength(2);
  });

  it("renders an em dash when the author date is invalid", () => {
    const item = { ...commit(), authoredAt: "not-a-date" };
    const graph = layoutGitHistoryGraph([item]);
    const markup = renderToStaticMarkup(
      <GitHistoryCommitRow
        commit={item}
        graphLaneCount={graph.maxLaneCount}
        graphRow={graph.rows[0]!}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
      />,
    );

    expect(markup).toContain('data-history-date="true">—</span>');
  });
});

describe("GitHistoryShaButtonView", () => {
  it("copies the full SHA while displaying its short form", () => {
    const onCopy = vi.fn();
    const button = GitHistoryShaButtonView({ sha: HEAD_SHA, isCopied: false, onCopy });
    const markup = renderToStaticMarkup(button);

    button.props.onClick();

    expect(onCopy).toHaveBeenCalledWith(HEAD_SHA);
    expect(markup).toContain(`>${HEAD_SHA.slice(0, 7)}</button>`);
  });

  it("replaces the short SHA with copied feedback", () => {
    const markup = renderToStaticMarkup(
      <GitHistoryShaButtonView sha={HEAD_SHA} isCopied={true} onCopy={() => {}} />,
    );

    expect(markup).toContain('data-copied="true"');
    expect(markup).toContain(`aria-label="Copied commit SHA ${HEAD_SHA}"`);
    expect(markup).toContain(">Copied</button>");
    expect(markup).not.toContain(`>${HEAD_SHA.slice(0, 7)}</button>`);
  });
});

describe("GitHistoryPanelView states", () => {
  it("switches to deduplicated branch tips without offering history pagination", () => {
    const tip = {
      ...commit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Feature branch tip", "Grace Hopper", [
        { kind: "branch", label: "feature/tips" },
      ]),
      parentShas: [HEAD_SHA],
    };
    const markup = renderView({ branchTips: [tip], nextCursor: 100, showOnlyTips: true });

    expect(markup).toContain("Feature branch tip");
    expect(markup).not.toContain("Render history rows");
    expect(markup).not.toContain("Load older commits");
    expect(markup).toContain('aria-label="Show all commits"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("offers the branch-tip overview only when the server supplies it", () => {
    const supported = renderView({ branchTips: [commit()] });
    const legacy = renderView({ branchTips: undefined });

    expect(supported).toContain('aria-label="Show branch tips"');
    expect(supported).toContain('aria-pressed="false"');
    expect(legacy).not.toContain('aria-label="Show branch tips"');
  });

  it("shows non-zero integration branch divergence with its comparison base", () => {
    const markup = renderView({
      comparison: { base: "upstream/main", ahead: 2, behind: 3 },
    });

    expect(markup).toContain('data-history-comparison="true"');
    expect(markup).toContain("2 ahead");
    expect(markup).toContain("3 behind");
    expect(markup).toContain("Compared with upstream/main: 2 ahead, 3 behind");
  });

  it("hides integration branch comparison when both counts are zero", () => {
    const markup = renderView({
      comparison: { base: "upstream/main", ahead: 0, behind: 0 },
    });

    expect(markup).not.toContain('data-history-comparison="true"');
  });

  it("shows a static initial loading state and disables refresh", () => {
    const markup = renderView({ commits: [], headSha: null, isInitialLoading: true });

    expect(markup).toContain("Loading commit history");
    expect(buttonTagBefore(markup, "Reload history")).toContain('disabled=""');
    expect(markup).not.toContain("animate");
  });

  it("shows an empty state after a successful empty page", () => {
    const markup = renderView({ commits: [], headSha: null, totalCount: 0 });

    expect(markup).toContain("No commits found.");
    expect(markup).toContain("0 commits");
    expect(buttonTagBefore(markup, "Reload history")).not.toContain('disabled=""');
  });

  it("shows an initial error with Retry", () => {
    const markup = renderView({
      commits: [],
      headSha: null,
      initialError: "Repository unavailable",
    });

    expect(markup).toContain("Could not load commit history.");
    expect(markup).toContain("Repository unavailable");
    expect(markup).toContain(">Retry</button>");
  });

  it("preserves rows while refreshing and disables refresh", () => {
    const markup = renderView({ isRefreshing: true });

    expect(markup).toContain("Render history rows");
    expect(markup).toContain("Reloading…");
    expect(buttonTagBefore(markup, "Reloading history")).toContain('disabled=""');
  });

  it("offers fetch all separately from reloading local history", () => {
    const markup = renderView();

    expect(markup).toContain("Fetch all");
    expect(markup).toContain('aria-label="Fetch all Git remotes"');
    expect(markup).toContain('aria-label="Reload history"');
  });

  it("preserves rows and exposes retry feedback when fetch all fails", () => {
    const fetching = renderView({ isFetching: true });
    const failed = renderView({ fetchError: "Authentication failed" });

    expect(fetching).toContain("Render history rows");
    expect(fetching).toContain("Fetching…");
    expect(buttonTagBefore(fetching, "Fetching all Git remotes")).toContain('disabled=""');
    expect(failed).toContain("Render history rows");
    expect(failed).toContain("Authentication failed");
    expect(failed).toContain(">Retry</button>");
  });

  it("hides fetch all when the connected server does not advertise support", () => {
    const markup = renderView({ canFetchAll: false });

    expect(markup).not.toContain("Fetch all");
    expect(markup).toContain('aria-label="Reload history"');
  });

  it("shows the repository total instead of only the loaded rows", () => {
    const markup = renderView({ totalCount: 7_838 });

    expect(markup).toContain("7,838 commits");
    expect(markup).not.toContain(">1 commit<");
  });

  it("preserves rows while loading or retrying an older page", () => {
    const loading = renderView({ nextCursor: 100, isLoadingMore: true });
    const failed = renderView({
      nextCursor: 100,
      loadMoreError: "Older page unavailable",
    });

    expect(loading).toContain("Render history rows");
    expect(loading).toContain("Loading older commits…");
    expect(buttonTagBefore(loading, "Loading older commits…")).toContain('disabled=""');
    expect(failed).toContain("Render history rows");
    expect(failed).toContain("Older page unavailable");
    expect(failed).toContain(">Retry</button>");
  });

  it("configures a fixed-height virtual list with a small overscan", () => {
    const commits = Array.from({ length: 20 }, (_, index) =>
      commit(index.toString(16).padStart(40, "0"), `Commit ${index}`),
    );
    const markup = renderView({ commits, headSha: null });

    expect(markup).toContain('data-total-count="20"');
    expect(markup).toContain('data-estimated-size="34"');
    expect(markup).toContain('data-draw-distance="136"');
    expect(markup.match(/data-history-row/g)).toHaveLength(4);
  });
});
