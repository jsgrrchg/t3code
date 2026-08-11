import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createPullRequestViewStateMemory,
  pullRequestCodeScopeKey,
  pullRequestTabViewKey,
  pullRequestViewStateKey,
} from "./pullRequestViewState";

const environmentA = EnvironmentId.make("environment-a");
const referenceA = {
  projectId: ProjectId.make("project-a"),
  repository: "owner/repository",
  number: 42,
};

describe("pull request view state", () => {
  it("isolates the same repository and number by environment and project", () => {
    expect(pullRequestViewStateKey(environmentA, referenceA)).not.toBe(
      pullRequestViewStateKey(EnvironmentId.make("environment-b"), referenceA),
    );
    expect(pullRequestViewStateKey(environmentA, referenceA)).not.toBe(
      pullRequestViewStateKey(environmentA, {
        ...referenceA,
        projectId: ProjectId.make("project-b"),
      }),
    );
  });

  it("keeps panel, chrome, scroll, folds, and loaded slices together", () => {
    const memory = createPullRequestViewStateMemory();
    const key = pullRequestViewStateKey(environmentA, referenceA);
    const codeScope = pullRequestCodeScopeKey("commit-a");
    const codeView = pullRequestTabViewKey("code", "commit-a");

    memory.rememberPanel(key, {
      activeTab: "code",
      timelineOrder: "oldest",
      selectedCommitOid: "commit-a",
    });
    memory.rememberChrome(key, "code", true);
    memory.rememberScroll(key, codeView, { top: 640, left: 18 });
    memory.rememberCode(key, codeScope, {
      foldOverride: "expanded",
      toggledFileKeys: new Set(["src/app.ts"]),
      slices: [
        { cursor: null, patch: "first", truncated: true, nextCursor: "page-2" },
        { cursor: "page-2", patch: "second", truncated: false, nextCursor: null },
      ],
    });

    expect(memory.get(key)).toEqual({
      activeTab: "code",
      timelineOrder: "oldest",
      selectedCommitOid: "commit-a",
      chromeCondensedByTab: { code: true },
      scrollByView: { [codeView]: { top: 640, left: 18 } },
      codeByScope: {
        [codeScope]: {
          foldOverride: "expanded",
          toggledFileKeys: new Set(["src/app.ts"]),
          slices: [
            { cursor: null, patch: "first", truncated: true, nextCursor: "page-2" },
            { cursor: "page-2", patch: "second", truncated: false, nextCursor: null },
          ],
        },
      },
    });
  });

  it("returns defensive normalized copies", () => {
    const memory = createPullRequestViewStateMemory();
    const files = new Set(["README.md"]);
    memory.rememberScroll("key", "summary", {
      top: Number.POSITIVE_INFINITY,
      left: -12,
    });
    memory.rememberCode("key", "all", {
      foldOverride: "folded",
      toggledFileKeys: files,
      slices: [{ cursor: null, patch: "patch", truncated: false, nextCursor: null }],
    });
    files.add("package.json");

    const remembered = memory.get("key");
    expect(remembered?.scrollByView.summary).toEqual({ top: 0, left: 0 });
    expect(remembered?.codeByScope.all?.toggledFileKeys).toEqual(new Set(["README.md"]));
    (remembered?.codeByScope.all?.toggledFileKeys as Set<string> | undefined)?.add("mutable.ts");
    expect(memory.get("key")?.codeByScope.all?.toggledFileKeys).toEqual(new Set(["README.md"]));
  });

  it("evicts the least recently used pull request", () => {
    const memory = createPullRequestViewStateMemory(2);
    const panel = {
      activeTab: "summary" as const,
      timelineOrder: "newest" as const,
      selectedCommitOid: null,
    };
    memory.rememberPanel("first", panel);
    memory.rememberPanel("second", panel);
    expect(memory.get("first")).not.toBeNull();
    memory.rememberPanel("third", panel);

    expect(memory.get("second")).toBeNull();
    expect(memory.get("first")).not.toBeNull();
    expect(memory.get("third")).not.toBeNull();
    expect(memory.size).toBe(2);
  });

  it("bounds accumulated commit diff scopes within one pull request", () => {
    const memory = createPullRequestViewStateMemory();
    for (let index = 0; index < 12; index += 1) {
      memory.rememberCode("key", `commit-${index}`, {
        foldOverride: null,
        toggledFileKeys: new Set(),
        slices: [{ cursor: null, patch: `patch-${index}`, truncated: false, nextCursor: null }],
      });
    }

    expect(memory.get("key")?.codeByScope["commit-0"]).toBeUndefined();
    expect(memory.get("key")?.codeByScope["commit-1"]).toBeUndefined();
    expect(memory.get("key")?.codeByScope["commit-2"]?.slices[0]?.patch).toBe("patch-2");
    expect(memory.get("key")?.codeByScope["commit-11"]?.slices[0]?.patch).toBe("patch-11");
  });
});
