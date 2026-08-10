import { useLayoutEffect, type RefObject } from "react";

import {
  getRememberedFilePreviewScroll,
  rememberFilePreviewScroll,
} from "./filePreviewScrollState";

interface UseRememberedFilePreviewScrollOptions {
  readonly scrollKey: string;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly viewportSelector?: string;
  readonly revealRequestId?: number | null;
  readonly restore?: boolean;
}

function readPosition(element: HTMLElement) {
  return { top: element.scrollTop, left: element.scrollLeft };
}

export function useRememberedFilePreviewScroll({
  scrollKey,
  rootRef,
  viewportSelector,
  revealRequestId = null,
  restore = true,
}: UseRememberedFilePreviewScrollOptions): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = viewportSelector ? root?.querySelector<HTMLElement>(viewportSelector) : root;
    if (!viewport) return;

    let latestPosition = readPosition(viewport);
    let restoreFrame: number | null = null;
    let userInteracted = false;
    const remembered = restore ? getRememberedFilePreviewScroll(scrollKey) : null;

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
      rememberFilePreviewScroll(scrollKey, {
        position: latestPosition,
        revealRequestId,
      });
    };
  }, [restore, revealRequestId, rootRef, scrollKey, viewportSelector]);
}
