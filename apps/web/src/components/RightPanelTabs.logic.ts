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

export function findNewlyOpenedChatThreadId(
  surfaces: ReadonlyArray<{
    readonly kind: string;
    readonly threadId?: string | null | undefined;
  }>,
  previousThreadIds: ReadonlySet<string>,
): string | null {
  return (
    surfaces.find(
      (surface) =>
        surface.kind === "chat" &&
        typeof surface.threadId === "string" &&
        !previousThreadIds.has(surface.threadId),
    )?.threadId ?? null
  );
}
