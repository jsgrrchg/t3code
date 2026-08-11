import { useLayoutEffect, type RefObject } from "react";

import {
  getPullRequestScrollPosition,
  rememberPullRequestScrollPosition,
} from "./pullRequestViewState";

export function useRememberedPullRequestScroll({
  pullRequestKey,
  viewKey,
  rootRef,
  viewportSelector,
  mountKey,
  enabled = true,
}: {
  readonly pullRequestKey: string;
  readonly viewKey: string;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly viewportSelector?: string;
  readonly mountKey: string;
  readonly enabled?: boolean;
}): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    const viewport = viewportSelector ? root?.querySelector<HTMLElement>(viewportSelector) : root;
    if (!viewport) return;

    let latestPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
    let restoreFrame: number | null = null;
    let userInteracted = false;
    const remembered = getPullRequestScrollPosition(pullRequestKey, viewKey);

    const cancelRestore = () => {
      userInteracted = true;
      if (restoreFrame === null) return;
      cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    };
    const handleScroll = () => {
      latestPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", cancelRestore, { passive: true });
    viewport.addEventListener("touchstart", cancelRestore, { passive: true });
    viewport.addEventListener("pointerdown", cancelRestore, { passive: true });
    window.addEventListener("keydown", cancelRestore, true);

    if (remembered) {
      viewport.scrollTop = remembered.top;
      viewport.scrollLeft = remembered.left;
      latestPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        if (userInteracted || !viewport.isConnected) return;
        viewport.scrollTop = remembered.top;
        viewport.scrollLeft = remembered.left;
        latestPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
      });
    }

    return () => {
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", cancelRestore);
      viewport.removeEventListener("touchstart", cancelRestore);
      viewport.removeEventListener("pointerdown", cancelRestore);
      window.removeEventListener("keydown", cancelRestore, true);
      latestPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
      rememberPullRequestScrollPosition(pullRequestKey, viewKey, latestPosition);
    };
  }, [enabled, mountKey, pullRequestKey, rootRef, viewKey, viewportSelector]);
}
