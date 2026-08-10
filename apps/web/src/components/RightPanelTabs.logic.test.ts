import { describe, expect, it } from "vite-plus/test";

import { findNewlyOpenedChatThreadId, resolveRightPanelTabKeyAction } from "./RightPanelTabs.logic";

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

describe("findNewlyOpenedChatThreadId", () => {
  it("announces a chat that already exists on the first panel mount", () => {
    expect(
      findNewlyOpenedChatThreadId([{ kind: "chat", threadId: "thread-child" }], new Set()),
    ).toBe("thread-child");
  });

  it("ignores surfaces that were already present", () => {
    expect(
      findNewlyOpenedChatThreadId(
        [{ kind: "chat", threadId: "thread-child" }],
        new Set(["thread-child"]),
      ),
    ).toBeNull();
  });
});
