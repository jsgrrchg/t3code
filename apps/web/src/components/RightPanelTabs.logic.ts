export type RightPanelTabKeyAction =
  | { readonly kind: "activate"; readonly index: number }
  | { readonly kind: "close" }
  | { readonly kind: "rename" }
  | null;

export function resolveRightPanelTabKeyAction(input: {
  readonly key: string;
  readonly currentIndex: number;
  readonly tabCount: number;
  readonly chat: boolean;
}): RightPanelTabKeyAction {
  if (input.currentIndex < 0 || input.tabCount <= 0) return null;
  if (input.key === "F2" && input.chat) return { kind: "rename" };
  if (input.key === "Delete") return { kind: "close" };
  if (input.key === "ArrowLeft") {
    return {
      kind: "activate",
      index: (input.currentIndex - 1 + input.tabCount) % input.tabCount,
    };
  }
  if (input.key === "ArrowRight") {
    return { kind: "activate", index: (input.currentIndex + 1) % input.tabCount };
  }
  if (input.key === "Home") return { kind: "activate", index: 0 };
  if (input.key === "End") return { kind: "activate", index: input.tabCount - 1 };
  return null;
}

export function resolvePanelChatOpenAnnouncementThreadId(input: {
  readonly requestedThreadId: string | null | undefined;
  readonly surfaces: ReadonlyArray<{
    readonly kind: string;
    readonly threadId?: string | null | undefined;
  }>;
}): string | null {
  if (!input.requestedThreadId) return null;
  return input.surfaces.some(
    (surface) => surface.kind === "chat" && surface.threadId === input.requestedThreadId,
  )
    ? input.requestedThreadId
    : null;
}

export function resolveFocusTargetAfterRemoteSurfaceRemoval(input: {
  readonly previousSurfaceIds: ReadonlySet<string>;
  readonly currentSurfaceIds: ReadonlySet<string>;
  readonly focusedSurfaceId: string | null;
  readonly activeSurfaceId: string | null;
}): { readonly kind: "owner" } | { readonly kind: "surface"; readonly surfaceId: string } | null {
  if (
    !input.focusedSurfaceId ||
    !input.previousSurfaceIds.has(input.focusedSurfaceId) ||
    input.currentSurfaceIds.has(input.focusedSurfaceId)
  ) {
    return null;
  }
  return input.activeSurfaceId
    ? { kind: "surface", surfaceId: input.activeSurfaceId }
    : { kind: "owner" };
}
