// @vitest-environment jsdom

import type { GitHistoryCommitSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listHarness = vi.hoisted(() => ({
  scroll: 0,
  scrollToOffset: vi.fn<(input: { offset: number; animated: boolean }) => Promise<void>>(),
}));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: React.forwardRef(function MockLegendList(
      props: { readonly onScroll?: () => void },
      ref: React.ForwardedRef<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: listHarness.scroll }),
        scrollToOffset: listHarness.scrollToOffset,
      }));
      return React.createElement("div", {
        "data-testid": "history-legend-list",
        onScroll: props.onScroll,
      });
    }),
  };
});

import { GitHistoryPanelView, type GitHistoryPanelViewProps } from "./GitHistoryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMIT: GitHistoryCommitSummary = {
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  parentShas: [],
  subject: "Remember scroll",
  authorName: "Test",
  authorEmail: "test@example.com",
  authoredAt: "2026-08-10T00:00:00Z",
  refs: [],
};

const baseProps: GitHistoryPanelViewProps = {
  commits: [COMMIT],
  headSha: COMMIT.sha,
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
  scrollKey: "target-a",
  initialScrollOffset: null,
  onRefresh: () => {},
  onFetchAll: () => {},
  onLoadOlder: () => {},
  onScrollOffsetChange: () => {},
  onOpenCommit: () => {},
};

describe("GitHistoryPanelView scroll restoration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listHarness.scroll = 0;
    listHarness.scrollToOffset.mockReset();
    listHarness.scrollToOffset.mockImplementation(async ({ offset }) => {
      listHarness.scroll = offset;
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("restores a remembered offset after rows mount", async () => {
    await act(async () => {
      root.render(<GitHistoryPanelView {...baseProps} initialScrollOffset={420} />);
    });

    expect(listHarness.scrollToOffset).toHaveBeenCalledWith({ offset: 420, animated: false });
  });

  it("saves the old target and restores an independent target", async () => {
    const rememberA = vi.fn();
    const rememberB = vi.fn();
    await act(async () => {
      root.render(
        <GitHistoryPanelView
          {...baseProps}
          initialScrollOffset={120}
          onScrollOffsetChange={rememberA}
        />,
      );
    });

    listHarness.scroll = 275;
    await act(async () => {
      container
        .querySelector('[data-testid="history-legend-list"]')
        ?.dispatchEvent(new Event("scroll"));
    });

    await act(async () => {
      root.render(
        <GitHistoryPanelView
          {...baseProps}
          scrollKey="target-b"
          initialScrollOffset={40}
          onScrollOffsetChange={rememberB}
        />,
      );
    });

    expect(rememberA).toHaveBeenLastCalledWith(275);
    expect(listHarness.scrollToOffset).toHaveBeenLastCalledWith({ offset: 40, animated: false });

    await act(async () => root.unmount());
    expect(rememberB).toHaveBeenLastCalledWith(40);
    root = createRoot(container);
  });
});
