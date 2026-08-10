import { describe, expect, it } from "vite-plus/test";

import {
  panelChatThreadIdsForClose,
  GIT_HISTORY_DISABLED_REASONS,
  resolveGitHistoryAvailability,
  resolveGitHistoryPanelTarget,
  resolvePanelChatOpenAnnouncementThreadId,
  resolveFocusTargetAfterRemoteSurfaceRemoval,
  resolveFocusedRightPanelSurfaceId,
  shouldClearRightPanelFocusOwner,
  resolveRightPanelTabKeyAction,
  surfacesClosedAfterPanelChatDeletion,
} from "./RightPanelTabs.logic";

describe("Git History right-panel availability", () => {
  it("requires project, confirmed Git, and an advertised server capability", () => {
    expect(
      resolveGitHistoryAvailability({
        hasProject: true,
        cwd: "/repo",
        isGitRepo: true,
        capability: true,
      }),
    ).toEqual({ available: true, disabledReason: "" });
    expect(
      resolveGitHistoryAvailability({
        hasProject: true,
        cwd: "/repo",
        isGitRepo: false,
        capability: true,
      }),
    ).toEqual({
      available: false,
      disabledReason: GIT_HISTORY_DISABLED_REASONS.repository,
    });
    expect(
      resolveGitHistoryAvailability({
        hasProject: true,
        cwd: "/repo",
        isGitRepo: true,
        capability: undefined,
      }),
    ).toEqual({
      available: false,
      disabledReason: GIT_HISTORY_DISABLED_REASONS.capability,
    });
  });

  it("returns an RPC target for History and commit tabs while available", () => {
    const available = { available: true, disabledReason: "" };
    const input = {
      activeSurfaceKind: "history",
      availability: available,
      environmentId: "environment-1",
      projectId: "project-1",
      threadId: "thread-1",
      cwd: "/repo/worktree",
    } as const;

    expect(resolveGitHistoryPanelTarget(input)).toEqual({
      environmentId: "environment-1",
      projectId: "project-1",
      threadId: "thread-1",
      cwd: "/repo/worktree",
    });
    expect(resolveGitHistoryPanelTarget({ ...input, activeSurfaceKind: "git-commit" })).toEqual({
      environmentId: "environment-1",
      projectId: "project-1",
      threadId: "thread-1",
      cwd: "/repo/worktree",
    });
    expect(resolveGitHistoryPanelTarget({ ...input, activeSurfaceKind: "diff" })).toBeNull();
    expect(
      resolveGitHistoryPanelTarget({
        ...input,
        availability: {
          available: false,
          disabledReason: GIT_HISTORY_DISABLED_REASONS.capability,
        },
      }),
    ).toBeNull();
  });
});

describe("right-panel chat close deletion", () => {
  const surfaces = [
    { id: "files", kind: "files" },
    { id: "chat:one", kind: "chat", threadId: "one" },
    { id: "diff", kind: "diff" },
    { id: "chat:two", kind: "chat", threadId: "two" },
  ] as const;

  it("selects every unique chat included in a close action", () => {
    expect(panelChatThreadIdsForClose([...surfaces, surfaces[1]])).toEqual(["one", "two"]);
  });

  it("keeps a chat surface open when its durable deletion fails", () => {
    expect(surfacesClosedAfterPanelChatDeletion(surfaces, new Set(["two"]))).toEqual([
      surfaces[0],
      surfaces[1],
      surfaces[2],
    ]);
    expect(surfacesClosedAfterPanelChatDeletion(surfaces, new Set(["one"]))).toEqual([
      surfaces[0],
      surfaces[2],
      surfaces[3],
    ]);
  });
});

describe("resolveRightPanelTabKeyAction", () => {
  it("wraps arrow navigation and resolves home and end", () => {
    expect(
      resolveRightPanelTabKeyAction({ key: "ArrowLeft", currentIndex: 0, tabCount: 3, chat: true }),
    ).toEqual({ kind: "activate", index: 2 });
    expect(
      resolveRightPanelTabKeyAction({
        key: "ArrowRight",
        currentIndex: 2,
        tabCount: 3,
        chat: true,
      }),
    ).toEqual({ kind: "activate", index: 0 });
    expect(
      resolveRightPanelTabKeyAction({ key: "Home", currentIndex: 2, tabCount: 3, chat: true }),
    ).toEqual({ kind: "activate", index: 0 });
    expect(
      resolveRightPanelTabKeyAction({ key: "End", currentIndex: 0, tabCount: 3, chat: true }),
    ).toEqual({ kind: "activate", index: 2 });
  });

  it("renames only chats and closes any surface", () => {
    expect(
      resolveRightPanelTabKeyAction({ key: "F2", currentIndex: 0, tabCount: 1, chat: true }),
    ).toEqual({ kind: "rename" });
    expect(
      resolveRightPanelTabKeyAction({ key: "F2", currentIndex: 0, tabCount: 1, chat: false }),
    ).toBeNull();
    expect(
      resolveRightPanelTabKeyAction({ key: "Delete", currentIndex: 0, tabCount: 1, chat: false }),
    ).toEqual({ kind: "close" });
  });
});

describe("resolvePanelChatOpenAnnouncementThreadId", () => {
  it("uses the one-shot request instead of the first historical chat", () => {
    expect(
      resolvePanelChatOpenAnnouncementThreadId({
        requestedThreadId: "thread-c",
        surfaces: [
          { kind: "chat", threadId: "thread-a" },
          { kind: "chat", threadId: "thread-b" },
          { kind: "chat", threadId: "thread-c" },
        ],
      }),
    ).toBe("thread-c");
  });

  it("does not announce a stale request", () => {
    expect(
      resolvePanelChatOpenAnnouncementThreadId({
        requestedThreadId: "thread-deleted",
        surfaces: [{ kind: "chat", threadId: "thread-a" }],
      }),
    ).toBeNull();
  });
});

describe("resolveFocusTargetAfterRemoteSurfaceRemoval", () => {
  it("moves focus to the server-selected fallback when the focused tab disappears", () => {
    expect(
      resolveFocusTargetAfterRemoteSurfaceRemoval({
        previousSurfaceIds: new Set(["chat:child", "diff"]),
        currentSurfaceIds: new Set(["diff"]),
        focusedSurfaceId: "chat:child",
        activeSurfaceId: "diff",
      }),
    ).toEqual({ kind: "surface", surfaceId: "diff" });
  });

  it("does not steal focus when it no longer belongs to the removed surface", () => {
    expect(
      resolveFocusTargetAfterRemoteSurfaceRemoval({
        previousSurfaceIds: new Set(["chat:child", "diff"]),
        currentSurfaceIds: new Set(["diff"]),
        focusedSurfaceId: null,
        activeSurfaceId: "diff",
      }),
    ).toBeNull();
  });
});

describe("resolveFocusedRightPanelSurfaceId", () => {
  it("does not attribute global panel controls to the active surface", () => {
    expect(resolveFocusedRightPanelSurfaceId(undefined)).toBeNull();
    expect(resolveFocusedRightPanelSurfaceId("chat:child")).toBe("chat:child");
  });
});

describe("shouldClearRightPanelFocusOwner", () => {
  it("clears stale ownership for outside and null blur targets", () => {
    expect(shouldClearRightPanelFocusOwner(false)).toBe(true);
    expect(shouldClearRightPanelFocusOwner(null)).toBe(true);
    expect(shouldClearRightPanelFocusOwner(true)).toBe(false);
  });
});
