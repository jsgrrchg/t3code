import { useLayoutEffect, type RefObject } from "react";

import {
  getRememberedFilePreviewScroll,
  rememberFilePreviewScroll,
  resolveFilePreviewRevealRequestId,
  shouldRestoreFilePreviewScroll,
} from "./filePreviewScrollState";

interface UseRememberedFilePreviewScrollOptions {
  readonly scrollKey: string;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly viewportSelector?: string;
  readonly revealRequestId?: number | null;
  readonly restoreForRevealRequestId?: number;
  readonly restore?: boolean;
  readonly enabled?: boolean;
}

function readPosition(element: HTMLElement) {
  return { top: element.scrollTop, left: element.scrollLeft };
}

export function useRememberedFilePreviewScroll({
  scrollKey,
  rootRef,
  viewportSelector,
  revealRequestId = null,
  restoreForRevealRequestId,
  restore = true,
  enabled = true,
}: UseRememberedFilePreviewScrollOptions): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    const viewport = viewportSelector ? root?.querySelector<HTMLElement>(viewportSelector) : root;
    if (!viewport) return;

    let latestPosition = readPosition(viewport);
    let restoreFrame: number | null = null;
    let userInteracted = false;
    const rememberedEntry = restore ? getRememberedFilePreviewScroll(scrollKey) : null;
    const remembered = shouldRestoreFilePreviewScroll(rememberedEntry, restoreForRevealRequestId)
      ? rememberedEntry
      : null;

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

    if (remembered) {
      viewport.scrollLeft = remembered.position.left;
      viewport.scrollTop = remembered.position.top;
      latestPosition = readPosition(viewport);
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        if (userInteracted || !viewport.isConnected) return;
        viewport.scrollLeft = remembered.position.left;
        viewport.scrollTop = remembered.position.top;
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
      const currentEntry = getRememberedFilePreviewScroll(scrollKey);
      rememberFilePreviewScroll(scrollKey, {
        position: latestPosition,
        revealRequestId: resolveFilePreviewRevealRequestId(
          currentEntry,
          revealRequestId,
          restoreForRevealRequestId,
        ),
      });
    };
  }, [
    enabled,
    restore,
    restoreForRevealRequestId,
    revealRequestId,
    rootRef,
    scrollKey,
    viewportSelector,
  ]);
}
