import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, GitObjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  pullRequestSurfaceId,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  updatePullRequestTabStatus,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const refC = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-C"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  it("remaps a file surface in place while preserving focus and reveal state", () => {
    useRightPanelStore.getState().open(refA, "history");
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    const before = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    const source = before.surfaces.find((surface) => surface.id === "file:src/index.ts");

    useRightPanelStore.getState().remapFileSurfaces([refA], "src/index.ts", "components/index.ts");

    const after = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(after.activeSurfaceId).toBe("file:components/index.ts");
    expect(after.surfaces.map((surface) => surface.id)).toEqual([
      "history",
      "file:components/index.ts",
    ]);
    expect(after.surfaces[1]).toEqual({
      ...source,
      id: "file:components/index.ts",
      relativePath: "components/index.ts",
    });
  });

  it("remaps every supplied thread and leaves unrelated threads untouched", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "components/index.ts");
    useRightPanelStore.getState().openFile(refB, "src/index.ts");
    useRightPanelStore.getState().openFile(refC, "src/index.ts");

    useRightPanelStore
      .getState()
      .remapFileSurfaces([refA, refB], "src/index.ts", "components/index.ts");

    const stateA = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(stateA.surfaces.filter((surface) => surface.kind === "file")).toHaveLength(1);
    expect(stateA.activeSurfaceId).toBe("file:components/index.ts");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces,
    ).toEqual([
      expect.objectContaining({
        id: "file:components/index.ts",
        relativePath: "components/index.ts",
      }),
    ]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refC).surfaces,
    ).toEqual([expect.objectContaining({ id: "file:src/index.ts", relativePath: "src/index.ts" })]);
  });

  it("keeps one commit diff tab per SHA and focuses the latest opened commit", () => {
    const first = GitObjectId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const second = GitObjectId.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    useRightPanelStore.getState().openGitCommit(refA, first);
    useRightPanelStore.getState().openGitCommit(refA, second);
    useRightPanelStore.getState().openGitCommit(refA, first);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: `git-commit:${first}`,
      surfaces: [
        { id: `git-commit:${first}`, kind: "git-commit", sha: first },
        { id: `git-commit:${second}`, kind: "git-commit", sha: second },
      ],
    });
  });

  it("opens a durable chat surface once and focuses it", () => {
    const childId = ThreadId.make("thread-child");
    useRightPanelStore.getState().openChat(refA, childId);
    useRightPanelStore.getState().openChat(refA, childId);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "chat:thread-child",
      surfaces: [{ id: "chat:thread-child", kind: "chat", threadId: childId }],
    });
  });

  it("prunes deleted chats without reopening closed chat tabs", () => {
    const firstId = ThreadId.make("thread-child-1");
    const secondId = ThreadId.make("thread-child-2");
    useRightPanelStore.getState().openChat(refA, firstId);
    useRightPanelStore.getState().openChat(refA, secondId);
    useRightPanelStore.getState().reconcileChatSurfaces(refA, [firstId]);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([
      { id: "chat:thread-child-1", kind: "chat", threadId: firstId },
    ]);
    expect(state.activeSurfaceId).toBe("chat:thread-child-1");
  });

  it("clears deleted child targets from diff and agents surfaces", () => {
    const childId = ThreadId.make("thread-child");
    useRightPanelStore.getState().openChat(refA, childId);
    useRightPanelStore.getState().openThreadDiff(refA, childId);
    useRightPanelStore.getState().openThreadAgents(refA, childId);

    useRightPanelStore.getState().reconcileChatSurfaces(refA, []);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [
        { id: "diff", kind: "diff", threadId: null },
        { id: "agents", kind: "agents", threadId: null },
      ],
    });
  });

  it("drops the legacy singleton terminal surface during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "terminal",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
    });
  });

  it("normalizes v10 Diff and Agents surfaces without source thread ids", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "agents",
            surfaces: [
              { id: "diff", kind: "diff" },
              { id: "agents", kind: "agents" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "agents",
          surfaces: [
            { id: "diff", kind: "diff", threadId: null },
            { id: "agents", kind: "agents", threadId: null },
          ],
        },
      },
    });
  });

  it("restores a persisted History singleton without changing the storage version", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "history",
            surfaces: [{ id: "history", kind: "history" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "history",
          surfaces: [{ id: "history", kind: "history" }],
        },
      },
    });
  });

  it("upgrades saved single-session terminal surfaces to split-capable surfaces", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "terminal:term-1",
            surfaces: [{ id: "terminal:term-1", kind: "terminal", resourceId: "term-1" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "terminal:term-1",
          surfaces: [
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
          ],
        },
      },
    });
  });

  it("upgrades saved file surfaces with neutral reveal state", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    });
  });

  it("upgrades the legacy singleton pull request surface to a reference-keyed tab", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    });
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "pull-request",
            surfaces: [
              {
                id: "pull-request",
                kind: "pull-request",
                projectId: "project-a",
                repository: "pingdotgg/t3code",
                number: 4909,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: id,
          surfaces: [
            {
              id,
              kind: "pull-request",
              projectId: "project-a",
              repository: "pingdotgg/t3code",
              number: 4909,
            },
          ],
        },
      },
    });
  });

  it("drops the pull-request list's shared panel so a restart opens the page fresh", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    });
    const panelState = {
      isOpen: true,
      activeSurfaceId: id,
      surfaces: [
        {
          id,
          kind: "pull-request" as const,
          projectId: "project-a",
          repository: "pingdotgg/t3code",
          number: 4909,
        },
      ],
    };
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:pull-requests-panel": panelState,
          "env-1:thread-A": panelState,
        },
      }),
    ).toEqual({ byThreadKey: { "env-1:thread-A": panelState } });
  });

  it("drops persisted plan surfaces and does not reopen an empty panel", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [{ id: "plan", kind: "plan" }],
          },
          "env-1:thread-B": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [
              { id: "plan", kind: "plan" },
              { id: "diff", kind: "diff" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [],
        },
        "env-1:thread-B": {
          isOpen: true,
          activeSurfaceId: "diff",
          surfaces: [{ id: "diff", kind: "diff", threadId: null }],
        },
      },
    });
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  it("opening a different kind keeps both surfaces and activates the new one", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("reopening an inactive singleton activates its existing surface", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "diff");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff", threadId: null },
        { id: "agents", kind: "agents", threadId: null },
      ],
    });
  });

  it("opens, focuses, closes, and reopens one History surface in relative order", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().open(refA, "history");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "history");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "history",
      surfaces: [
        { id: "diff", kind: "diff", threadId: null },
        { id: "history", kind: "history" },
        { id: "agents", kind: "agents", threadId: null },
      ],
    });

    useRightPanelStore.getState().closeSurface(refA, "history");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["diff", "agents"]);

    useRightPanelStore.getState().open(refA, "history");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["diff", "agents", "history"]);

    useRightPanelStore.getState().closeAllSurfaces(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("reorders surfaces without changing the active surface or another thread", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().open(refA, "history");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refB, "files");

    useRightPanelStore.getState().moveSurface(refA, "agents", "diff");

    const stateA = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(stateA.surfaces.map((surface) => surface.id)).toEqual(["agents", "diff", "history"]);
    expect(stateA.activeSurfaceId).toBe("agents");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });

    useRightPanelStore.getState().moveSurface(refA, "missing", "diff");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["agents", "diff", "history"]);
  });

  it("tracks the conversation whose turn diff is shown in the owner's panel", () => {
    const childId = ThreadId.make("thread-child");
    useRightPanelStore.getState().openThreadDiff(refA, childId);

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "diff",
      kind: "diff",
      threadId: childId,
    });

    useRightPanelStore.getState().open(refA, "diff");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "diff",
      kind: "diff",
      threadId: null,
    });
  });

  it("tracks the conversation whose subagents are shown in the owner's panel", () => {
    const childId = ThreadId.make("thread-child");
    useRightPanelStore.getState().openThreadAgents(refA, childId);

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "agents",
      kind: "agents",
      threadId: childId,
    });

    useRightPanelStore.getState().open(refA, "agents");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "agents",
      kind: "agents",
      threadId: null,
    });
  });

  it("keeps files as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refA, "files");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 87);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: 87,
          revealRequestId: 2,
        },
      ],
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 3,
        },
      ],
    });
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().openFile(refA, "README.md");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents", threadId: null }],
    });

    useRightPanelStore.getState().openFile(refB, "conductor.json");
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("close hides the panel without clearing its selected surface", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(
      selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toEqual({ id: "agents", kind: "agents", threadId: null });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents", threadId: null }],
    });
  });

  it("toggles empty panel visibility without creating a surface", () => {
    useRightPanelStore.getState().toggleVisibility(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });

    useRightPanelStore.getState().toggleVisibility(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("toggle hides the panel without discarding the active surface", () => {
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff", threadId: null }],
    });
  });

  it("toggle to a different kind switches active", () => {
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
  });

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("tracks one surface per browser session", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "browser:tab-b"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "browser:tab-b",
      kind: "preview",
      resourceId: "tab-b",
    });
  });

  it("tracks one surface per pull request", () => {
    const first = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
    const second = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4910 };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    useRightPanelStore.getState().openPullRequest(refA, first);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(first),
      pullRequestSurfaceId(second),
    ]);
    expect(state.activeSurfaceId).toBe(pullRequestSurfaceId(first));
  });

  it("keeps one pull request read from two servers as two tabs", () => {
    const local = {
      environmentId: "local",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    };
    const remote = { ...local, environmentId: "remote" };

    useRightPanelStore.getState().openPullRequest(refA, local);
    useRightPanelStore.getState().openPullRequest(refA, remote);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(local),
      pullRequestSurfaceId(remote),
    ]);
  });

  it("keeps the page's panel tabs reachable when the set of connected servers changes", () => {
    // The pull-requests page keys its one shared panel by a fixed sentinel environment, not by
    // whichever capable server happens to sort first (see PULL_REQUESTS_PANEL_ENVIRONMENT_ID in
    // _chat.pull-requests.tsx) — a server disconnecting must not move every open tab to a store
    // key nobody wrote them under.
    const panelId = ThreadId.make("pull-requests-panel");
    const stableRef = scopeThreadRef("pull-requests-panel" as EnvironmentId, panelId);
    const fromServerA = {
      environmentId: "server-a",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 1,
    };
    const fromServerB = {
      environmentId: "server-b",
      projectId: "project-b",
      repository: "pingdotgg/t3code",
      number: 2,
    };

    // Both servers connected: tabs from each open under the one stable ref.
    useRightPanelStore.getState().openPullRequest(stableRef, fromServerA);
    useRightPanelStore.getState().openPullRequest(stableRef, fromServerB);

    // Server A disconnects. The stable ref does not depend on which servers remain connected, so
    // the same lookup still finds both tabs.
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, stableRef);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(fromServerA),
      pullRequestSurfaceId(fromServerB),
    ]);

    // The bug this guards against: a ref keyed by the first capable environment instead of a
    // fixed sentinel changes identity when that environment drops out, and a lookup under the new
    // key finds nothing even though the tabs are still sitting under the old one.
    const refWhileBothConnected = scopeThreadRef("server-a" as EnvironmentId, panelId);
    const refAfterServerADisconnects = scopeThreadRef("server-b" as EnvironmentId, panelId);
    expect(refWhileBothConnected).not.toEqual(refAfterServerADisconnects);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        refAfterServerADisconnects,
      ).surfaces,
    ).toEqual([]);
  });

  describe("updatePullRequestTabStatus", () => {
    const status = (isDraft: boolean) => ({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
      state: "open" as const,
      isDraft,
    });

    // Regression for the tab wearing no state: this failed when the status was written under a
    // key rebuilt from the pull request while the tab strip reads it under the surface's own id.
    it("keys a status under the same id a surface opened from an environment carries", () => {
      const target = {
        environmentId: "remote",
        projectId: "project-a",
        repository: "pingdotgg/t3code",
        number: 4909,
      };
      useRightPanelStore.getState().openPullRequest(refA, target);
      const surface = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        refA,
      );
      expect(surface).not.toBeNull();

      const statuses = updatePullRequestTabStatus({}, surface!.id, status(false));
      expect(statuses[surface!.id]).toEqual(status(false));
    });

    it("keys a status under the same id a thread surface with no environment carries", () => {
      const target = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
      useRightPanelStore.getState().openPullRequest(refA, target);
      const surface = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        refA,
      );
      expect(surface).not.toBeNull();

      const statuses = updatePullRequestTabStatus({}, surface!.id, status(false));
      expect(statuses[surface!.id]).toEqual(status(false));
    });

    it("returns the identical map when the tab's state and draft flag are unchanged", () => {
      const first = updatePullRequestTabStatus({}, "pull-request:1", status(false));
      const second = updatePullRequestTabStatus(first, "pull-request:1", status(false));
      expect(second).toBe(first);
    });

    it("replaces the entry when the draft flag changes", () => {
      const first = updatePullRequestTabStatus({}, "pull-request:1", status(false));
      const second = updatePullRequestTabStatus(first, "pull-request:1", status(true));
      expect(second).not.toBe(first);
      expect(second["pull-request:1"]).toEqual(status(true));
    });
  });

  it("tracks one surface per terminal session", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openTerminal(refA, "term-2");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([
      {
        id: "terminal:term-1",
        kind: "terminal",
        resourceId: "term-1",
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
      },
      {
        id: "terminal:term-2",
        kind: "terminal",
        resourceId: "term-2",
        terminalIds: ["term-2"],
        activeTerminalId: "term-2",
      },
    ]);
    expect(state.activeSurfaceId).toBe("terminal:term-2");
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
    });

    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("tracks vertical layout for a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2", "vertical");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      splitDirection: "vertical",
    });
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing other surfaces keeps the selected surface active", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeOtherSurfaces(refA, "file:src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    });
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("reconciles browser surfaces without deleting other surface kinds", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b", "tab-c"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["terminal:term-1", "browser:tab-b", "browser:tab-c"]);
  });

  it("preserves user placement when reconciling browser surfaces", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");
    useRightPanelStore.getState().moveSurface(refA, "browser:tab-b", "diff");

    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-a", "tab-b", "tab-c"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["browser:tab-a", "browser:tab-b", "diff", "browser:tab-c"]);
  });
});
