export type RightPanelTabKeyAction =
  | { readonly kind: "activate"; readonly index: number }
  | { readonly kind: "close" }
  | { readonly kind: "rename" }
  | null;

export const RIGHT_PANEL_EMPTY_SURFACE_ORDER = [
  "browser",
  "terminal",
  "files",
  "diff",
  "agents",
  "history",
] as const;

export const RIGHT_PANEL_ADD_MENU_SURFACE_ORDER = [
  "browser",
  "terminal",
  "files",
  "diff",
  "history",
  "agents",
] as const;

export type StandardRightPanelSurfaceKind = (typeof RIGHT_PANEL_EMPTY_SURFACE_ORDER)[number];

export const GIT_HISTORY_DISABLED_REASONS = {
  project: "History is only available when a project is open.",
  capability: "The connected server needs to support Git history.",
  checking: "Checking whether this project is a Git repository.",
  repository: "History is only available for Git repositories.",
} as const;

export interface GitHistoryAvailability {
  readonly available: boolean;
  readonly disabledReason: string;
}

export function resolveGitHistoryAvailability(input: {
  readonly hasProject: boolean;
  readonly cwd: string | null;
  readonly isGitRepo: boolean | null;
  readonly capability: boolean | undefined;
}): GitHistoryAvailability {
  if (!input.hasProject || input.cwd === null) {
    return { available: false, disabledReason: GIT_HISTORY_DISABLED_REASONS.project };
  }
  if (input.capability !== true) {
    return { available: false, disabledReason: GIT_HISTORY_DISABLED_REASONS.capability };
  }
  if (input.isGitRepo === false) {
    return { available: false, disabledReason: GIT_HISTORY_DISABLED_REASONS.repository };
  }
  if (input.isGitRepo === null) {
    return { available: false, disabledReason: GIT_HISTORY_DISABLED_REASONS.checking };
  }
  return { available: true, disabledReason: "" };
}

export function resolveGitHistoryPanelTarget<
  EnvironmentId extends string,
  ProjectId extends string,
  ThreadId extends string,
>(input: {
  readonly activeSurfaceKind: string | null;
  readonly availability: GitHistoryAvailability;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly cwd: string | null;
}): {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly cwd: string;
} | null {
  return (input.activeSurfaceKind === "history" || input.activeSurfaceKind === "git-commit") &&
    input.availability.available &&
    input.environmentId !== null &&
    input.projectId !== null &&
    input.cwd !== null
    ? {
        environmentId: input.environmentId,
        projectId: input.projectId,
        threadId: input.threadId,
        cwd: input.cwd,
      }
    : null;
}

interface ClosableRightPanelSurface<ThreadId extends string = string> {
  readonly kind: string;
  readonly threadId?: ThreadId | null;
}

export function panelChatThreadIdsForClose<ThreadId extends string>(
  surfaces: readonly ClosableRightPanelSurface<ThreadId>[],
): ThreadId[] {
  return [
    ...new Set(
      surfaces.flatMap((surface) =>
        surface.kind === "chat" && surface.threadId ? [surface.threadId] : [],
      ),
    ),
  ];
}

export function surfacesClosedAfterPanelChatDeletion<T extends ClosableRightPanelSurface>(
  surfaces: readonly T[],
  failedChatThreadIds: ReadonlySet<string>,
): T[] {
  return surfaces.filter(
    (surface) =>
      surface.kind !== "chat" || !surface.threadId || !failedChatThreadIds.has(surface.threadId),
  );
}

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

export function resolveFocusedRightPanelSurfaceId(
  focusOwnerSurfaceId: string | undefined,
): string | null {
  return focusOwnerSurfaceId ?? null;
}

export function shouldClearRightPanelFocusOwner(
  relatedTargetRemainsInside: boolean | null,
): boolean {
  return relatedTargetRemainsInside !== true;
}
