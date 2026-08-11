import { useLayoutEffect, type RefObject } from "react";

import {
  getDiffPanelViewState,
  rememberDiffPanelScrollPosition,
  shouldRestoreDiffPanelScroll,
} from "~/diffPanelViewState";

interface UseRememberedDiffPanelScrollOptions {
  readonly scrollKey: string | null;
  readonly mountKey: string;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly revealRequestId: number | null;
  readonly enabled?: boolean;
}

function readPosition(element: HTMLElement) {
  return { top: element.scrollTop, left: element.scrollLeft };
}

export function useRememberedDiffPanelScroll({
  scrollKey,
  mountKey,
  rootRef,
  revealRequestId,
  enabled = true,
}: UseRememberedDiffPanelScrollOptions): void {
  useLayoutEffect(() => {
    if (!enabled || scrollKey === null) return;
    const viewport = rootRef.current?.querySelector<HTMLElement>(".diff-render-surface");
    if (!viewport) return;

    let latestPosition = readPosition(viewport);
    let restoreFrame: number | null = null;
    let userInteracted = false;
    const remembered = getDiffPanelViewState(scrollKey);
    const shouldRestore = shouldRestoreDiffPanelScroll(remembered, revealRequestId);

    const cancelRestore = () => {
      userInteracted = true;
      if (restoreFrame === null) return;
      cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    };
    const handleScroll = () => {
      latestPosition = readPosition(viewport);
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", cancelRestore, { passive: true });
    viewport.addEventListener("touchstart", cancelRestore, { passive: true });
    viewport.addEventListener("pointerdown", cancelRestore, { passive: true });
    window.addEventListener("keydown", cancelRestore, true);

    if (shouldRestore) {
      viewport.scrollLeft = remembered.scrollPosition.left;
      viewport.scrollTop = remembered.scrollPosition.top;
      latestPosition = readPosition(viewport);
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        if (userInteracted || !viewport.isConnected) return;
        viewport.scrollLeft = remembered.scrollPosition.left;
        viewport.scrollTop = remembered.scrollPosition.top;
        latestPosition = readPosition(viewport);
      });
    }

    return () => {
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", cancelRestore);
      viewport.removeEventListener("touchstart", cancelRestore);
      viewport.removeEventListener("pointerdown", cancelRestore);
      window.removeEventListener("keydown", cancelRestore, true);
      latestPosition = readPosition(viewport);
      rememberDiffPanelScrollPosition(scrollKey, latestPosition);
    };
  }, [enabled, mountKey, revealRequestId, rootRef, scrollKey]);
}
