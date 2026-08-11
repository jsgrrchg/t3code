// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useRef } from "react";

import {
  getDiffPanelViewState,
  rememberDiffPanelRevealRequest,
  rememberDiffPanelScrollPosition,
} from "~/diffPanelViewState";

import { useRememberedDiffPanelScroll } from "./useRememberedDiffPanelScroll";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: { scrollKey: string; mountKey: string; revealRequestId?: number | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useRememberedDiffPanelScroll({
    scrollKey: props.scrollKey,
    mountKey: props.mountKey,
    rootRef,
    revealRequestId: props.revealRequestId ?? null,
  });
  return (
    <div ref={rootRef}>
      <div key={props.mountKey} className="diff-render-surface" />
    </div>
  );
}

describe("useRememberedDiffPanelScroll", () => {
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

  it("restores a remembered position and captures the latest position on unmount", async () => {
    const scrollKey = "scroll-restore-and-capture";
    rememberDiffPanelScrollPosition(scrollKey, { top: 180, left: 22 });

    await act(async () => root.render(<Harness scrollKey={scrollKey} mountKey="first" />));
    const viewport = container.querySelector<HTMLElement>(".diff-render-surface");
    expect(viewport?.scrollTop).toBe(180);
    expect(viewport?.scrollLeft).toBe(22);

    if (!viewport) throw new Error("Expected diff viewport");
    viewport.scrollTop = 460;
    viewport.scrollLeft = 35;
    viewport.dispatchEvent(new Event("scroll"));

    await act(async () => root.unmount());
    expect(getDiffPanelViewState(scrollKey)?.scrollPosition).toEqual({ top: 460, left: 35 });
    root = createRoot(container);
  });

  it("captures and restores scroll when the code view itself remounts", async () => {
    const scrollKey = "scroll-code-view-remount";
    rememberDiffPanelScrollPosition(scrollKey, { top: 90, left: 0 });
    await act(async () => root.render(<Harness scrollKey={scrollKey} mountKey="first" />));

    const firstViewport = container.querySelector<HTMLElement>(".diff-render-surface");
    if (!firstViewport) throw new Error("Expected first diff viewport");
    firstViewport.scrollTop = 275;

    await act(async () => root.render(<Harness scrollKey={scrollKey} mountKey="second" />));
    const secondViewport = container.querySelector<HTMLElement>(".diff-render-surface");

    expect(secondViewport).not.toBe(firstViewport);
    expect(secondViewport?.scrollTop).toBe(275);
  });

  it("does not restore stale scroll when a new file reveal is pending", async () => {
    const scrollKey = "scroll-new-reveal";
    rememberDiffPanelScrollPosition(scrollKey, { top: 340, left: 18 });
    rememberDiffPanelRevealRequest(scrollKey, 3);

    await act(async () =>
      root.render(<Harness scrollKey={scrollKey} mountKey="first" revealRequestId={4} />),
    );
    const viewport = container.querySelector<HTMLElement>(".diff-render-surface");

    expect(viewport?.scrollTop).toBe(0);
    expect(viewport?.scrollLeft).toBe(0);
  });
});
