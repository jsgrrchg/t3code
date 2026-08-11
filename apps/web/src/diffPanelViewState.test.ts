import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createDiffPanelViewStateMemory,
  diffPanelViewStateKey,
  isDiffPanelRevealRequestHandled,
  shouldRestoreDiffPanelScroll,
} from "./diffPanelViewState";

const threadA = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-a"));
const threadB = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-b"));

describe("diff panel view state", () => {
  it("isolates views by thread and diff section", () => {
    expect(diffPanelViewStateKey(threadA, "branch")).not.toBe(
      diffPanelViewStateKey(threadB, "branch"),
    );
    expect(diffPanelViewStateKey(threadA, "branch")).not.toBe(
      diffPanelViewStateKey(threadA, "turn:turn-1"),
    );
  });

  it("preserves scroll, collapse, and reveal state independently", () => {
    const memory = createDiffPanelViewStateMemory();
    const key = diffPanelViewStateKey(threadA, "branch");

    memory.rememberScrollPosition(key, { top: 320, left: 24 });
    memory.rememberCollapsedFileKeys(key, new Set(["src/app.ts"]));
    memory.rememberRevealRequest(key, 4);

    expect(memory.get(key)).toEqual({
      collapsedFileKeys: new Set(["src/app.ts"]),
      scrollPosition: { top: 320, left: 24 },
      revealRequestId: 4,
    });
  });

  it("returns defensive normalized copies", () => {
    const memory = createDiffPanelViewStateMemory();
    const key = diffPanelViewStateKey(threadA, "unstaged");
    const sourceKeys = new Set(["README.md"]);

    memory.rememberCollapsedFileKeys(key, sourceKeys);
    memory.rememberScrollPosition(key, { top: Number.POSITIVE_INFINITY, left: -10 });
    memory.rememberRevealRequest(key, -1);
    sourceKeys.add("package.json");

    const remembered = memory.get(key);
    expect(remembered).toEqual({
      collapsedFileKeys: new Set(["README.md"]),
      scrollPosition: { top: 0, left: 0 },
      revealRequestId: null,
    });
    (remembered?.collapsedFileKeys as Set<string> | undefined)?.add("mutable.ts");
    expect(memory.get(key)?.collapsedFileKeys).toEqual(new Set(["README.md"]));
  });

  it("lets a new file reveal win over old scroll and restores a consumed reveal", () => {
    const entry = {
      collapsedFileKeys: new Set<string>(),
      scrollPosition: { top: 420, left: 12 },
      revealRequestId: 7,
    };

    expect(shouldRestoreDiffPanelScroll(entry, 8)).toBe(false);
    expect(shouldRestoreDiffPanelScroll(entry, 7)).toBe(true);
    expect(shouldRestoreDiffPanelScroll(entry, null)).toBe(true);
    expect(isDiffPanelRevealRequestHandled(entry, 7)).toBe(true);
    expect(isDiffPanelRevealRequestHandled(entry, 8)).toBe(false);
  });

  it("evicts the least recently used view", () => {
    const memory = createDiffPanelViewStateMemory(2);
    memory.rememberScrollPosition("first", { top: 1, left: 0 });
    memory.rememberScrollPosition("second", { top: 2, left: 0 });
    expect(memory.get("first")).not.toBeNull();
    memory.rememberScrollPosition("third", { top: 3, left: 0 });

    expect(memory.get("second")).toBeNull();
    expect(memory.get("first")).not.toBeNull();
    expect(memory.get("third")).not.toBeNull();
    expect(memory.size).toBe(2);
  });
});
