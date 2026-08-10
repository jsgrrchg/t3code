import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { CreateThreadInput } from "@t3tools/client-runtime/operations";
import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

export const PANEL_CHAT_PICKER_RESULT_LIMIT = 50;

export function getActivePanelChatThreadId(
  surface: { readonly kind: string; readonly threadId?: ThreadId | null } | null | undefined,
): ThreadId | null {
  return surface?.kind === "chat" ? (surface.threadId ?? null) : null;
}

export function filterPanelChatPickerItems<
  TChat extends { readonly threadId: string; readonly title: string },
>(chats: ReadonlyArray<TChat>, query: string, limit = PANEL_CHAT_PICKER_RESULT_LIMIT): TChat[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingChats =
    normalizedQuery.length === 0
      ? chats
      : chats.filter((chat) => chat.title.toLocaleLowerCase().includes(normalizedQuery));
  return matchingChats.slice(0, Math.max(0, limit));
}

export function buildPanelChatCreateInput(input: {
  readonly parent: Pick<
    OrchestrationThreadShell,
    | "id"
    | "projectId"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
  >;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}): CreateThreadInput {
  return {
    threadId: input.threadId,
    projectId: input.parent.projectId,
    parentThreadId: input.parent.id,
    title: "New chat",
    modelSelection: input.parent.modelSelection,
    runtimeMode: input.parent.runtimeMode,
    interactionMode: input.parent.interactionMode,
    branch: input.parent.branch,
    worktreePath: input.parent.worktreePath,
    createdAt: input.createdAt,
  };
}

export function panelChatShellsForParent(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  parent: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.environmentId === parent.environmentId &&
      thread.parentThreadId === parent.id &&
      thread.archivedAt === null,
  );
}
