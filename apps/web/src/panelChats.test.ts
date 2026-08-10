import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPanelChatCreateInput, panelChatShellsForParent } from "./panelChats";

function makeShell(input: {
  id: string;
  parentThreadId?: string | null;
  environmentId?: string;
}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    ...(input.parentThreadId !== undefined
      ? { parentThreadId: input.parentThreadId ? ThreadId.make(input.parentThreadId) : null }
      : {}),
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/tmp/worktree",
    latestTurn: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("panel chats", () => {
  it("inherits execution context while assigning the parent relationship", () => {
    const parent = makeShell({ id: "thread-parent" });
    expect(
      buildPanelChatCreateInput({
        parent,
        threadId: ThreadId.make("thread-child"),
        createdAt: "2026-08-09T01:00:00.000Z",
      }),
    ).toMatchObject({
      threadId: "thread-child",
      projectId: "project-1",
      parentThreadId: "thread-parent",
      title: "New chat",
      branch: "main",
      worktreePath: "/tmp/worktree",
    });
  });

  it("selects only live children from the same environment", () => {
    const parent = makeShell({ id: "thread-parent" });
    const child = makeShell({ id: "thread-child", parentThreadId: parent.id });
    const otherEnvironment = makeShell({
      id: "thread-remote-child",
      parentThreadId: parent.id,
      environmentId: "environment-2",
    });
    const archived = { ...child, id: ThreadId.make("thread-archived"), archivedAt: "2026-08-09" };

    expect(
      panelChatShellsForParent([parent, child, otherEnvironment, archived], parent).map(
        (thread) => thread.id,
      ),
    ).toEqual([child.id]);
  });
});
