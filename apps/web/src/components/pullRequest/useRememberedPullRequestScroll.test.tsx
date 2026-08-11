// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getPullRequestScrollPosition,
  rememberPullRequestScrollPosition,
} from "./pullRequestViewState";
import { useRememberedPullRequestScroll } from "./useRememberedPullRequestScroll";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: { pullRequestKey: string; viewKey: string; mountKey: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useRememberedPullRequestScroll({ ...props, rootRef });
  return <div ref={rootRef} />;
}

describe("useRememberedPullRequestScroll", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
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

  it("restores a view and captures its latest position on unmount", async () => {
    rememberPullRequestScrollPosition("pr-a", "summary", { top: 240, left: 7 });
    await act(async () =>
      root.render(<Harness pullRequestKey="pr-a" viewKey="summary" mountKey="first" />),
    );
    const viewport = container.firstElementChild as HTMLDivElement | null;
    expect(viewport?.scrollTop).toBe(240);
    expect(viewport?.scrollLeft).toBe(7);

    if (!viewport) throw new Error("Expected pull request viewport");
    viewport.scrollTop = 510;
    viewport.scrollLeft = 16;
    viewport.dispatchEvent(new Event("scroll"));
    await act(async () => root.unmount());

    expect(getPullRequestScrollPosition("pr-a", "summary")).toEqual({ top: 510, left: 16 });
    root = createRoot(container);
  });

  it("keeps positions independent by pull request and view", async () => {
    rememberPullRequestScrollPosition("pr-a", "summary", { top: 90, left: 0 });
    rememberPullRequestScrollPosition("pr-a", "timeline", { top: 180, left: 0 });
    rememberPullRequestScrollPosition("pr-b", "summary", { top: 270, left: 0 });

    await act(async () =>
      root.render(<Harness pullRequestKey="pr-a" viewKey="timeline" mountKey="first" />),
    );
    expect((container.firstElementChild as HTMLElement | null)?.scrollTop).toBe(180);
  });
});
