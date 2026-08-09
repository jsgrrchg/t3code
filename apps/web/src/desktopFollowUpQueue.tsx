import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { isElectron } from "./env";
import { useThreadShells } from "./state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "./state/environments";
import { threadEnvironment } from "./state/threads";
import { useAtomCommand } from "./state/use-atom-command";
import {
  type DesktopQueuedFollowUp,
  type DesktopQueuedMessageFollowUp,
  useDesktopFollowUpQueueStore,
} from "./desktopFollowUpQueueStore";

function modelSelectionsEqual(
  left: DesktopQueuedMessageFollowUp["modelSelection"],
  right: ModelSelection,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

type QueueDispatchThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "session" | "modelSelection" | "branch"
> & {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

export function useDispatchDesktopQueuedFollowUp() {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const runProviderAction = useAtomCommand(threadEnvironment.runProviderAction, {
    reportFailure: false,
  });

  return useCallback(
    async (entry: DesktopQueuedFollowUp, thread: QueueDispatchThread): Promise<boolean> => {
      const queue = useDesktopFollowUpQueueStore.getState();
      if (!queue.claim(entry.id)) return false;

      try {
        if (entry.kind === "provider-action") {
          const result = await runProviderAction({
            environmentId: entry.environmentId,
            input: {
              commandId: entry.commandId,
              threadId: entry.threadId,
              action: entry.action,
              createdAt: entry.createdAt,
            },
          });
          if (result._tag === "Failure") return false;

          useDesktopFollowUpQueueStore.getState().remove(entry.id);
          return true;
        }

        const metadataChanged =
          !modelSelectionsEqual(entry.modelSelection, thread.modelSelection) ||
          (entry.branch !== undefined && entry.branch !== thread.branch);
        if (metadataChanged) {
          const result = await updateMetadata({
            environmentId: entry.environmentId,
            input: {
              commandId: CommandId.make(`${entry.commandId}:metadata`),
              threadId: entry.threadId,
              ...(!modelSelectionsEqual(entry.modelSelection, thread.modelSelection)
                ? { modelSelection: entry.modelSelection }
                : {}),
              ...(entry.branch !== undefined && entry.branch !== thread.branch
                ? { branch: entry.branch }
                : {}),
            },
          });
          if (result._tag === "Failure") return false;
        }

        if (entry.runtimeMode !== thread.runtimeMode) {
          const result = await setRuntimeMode({
            environmentId: entry.environmentId,
            input: {
              commandId: CommandId.make(`${entry.commandId}:runtime-mode`),
              threadId: entry.threadId,
              runtimeMode: entry.runtimeMode,
              createdAt: entry.createdAt,
            },
          });
          if (result._tag === "Failure") return false;
        }

        if (entry.interactionMode !== thread.interactionMode) {
          const result = await setInteractionMode({
            environmentId: entry.environmentId,
            input: {
              commandId: CommandId.make(`${entry.commandId}:interaction-mode`),
              threadId: entry.threadId,
              interactionMode: entry.interactionMode,
              createdAt: entry.createdAt,
            },
          });
          if (result._tag === "Failure") return false;
        }

        const result = await startTurn({
          environmentId: entry.environmentId,
          input: {
            commandId: entry.commandId,
            threadId: entry.threadId,
            message: {
              messageId: entry.messageId,
              role: "user",
              text: entry.text,
              attachments: entry.attachments,
            },
            modelSelection: entry.modelSelection,
            titleSeed: entry.titleSeed,
            runtimeMode: entry.runtimeMode,
            interactionMode: entry.interactionMode,
            createdAt: entry.createdAt,
          },
        });
        if (result._tag === "Failure") return false;

        useDesktopFollowUpQueueStore.getState().remove(entry.id);
        return true;
      } finally {
        useDesktopFollowUpQueueStore.getState().release(entry.id);
      }
    },
    [runProviderAction, setInteractionMode, setRuntimeMode, startTurn, updateMetadata],
  );
}

/** Renderer-wide drain so queued work continues after the user navigates away. */
export function DesktopFollowUpQueueDrain() {
  const entries = useDesktopFollowUpQueueStore((state) => state.entries);
  const dispatchingEntryId = useDesktopFollowUpQueueStore((state) => state.dispatchingEntryId);
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const dispatchEntry = useDispatchDesktopQueuedFollowUp();
  const lastAttemptKeyRef = useRef<string | null>(null);

  const candidate = useMemo(() => {
    if (!isElectron || dispatchingEntryId !== null) return null;
    for (const entry of entries) {
      const environment = environments.find(
        (candidate) => candidate.environmentId === entry.environmentId,
      );
      const environmentReady =
        entry.environmentId === primaryEnvironmentId ||
        environment?.connection.phase === "connected";
      if (!environmentReady) continue;
      const thread = threads.find(
        (candidate) =>
          candidate.environmentId === entry.environmentId && candidate.id === entry.threadId,
      );
      if (!thread) continue;
      if (thread.session?.status === "running" || thread.session?.status === "starting") continue;
      return { entry, thread };
    }
    return null;
  }, [dispatchingEntryId, entries, environments, primaryEnvironmentId, threads]);

  useEffect(() => {
    if (!candidate) return;
    const attemptKey = `${candidate.entry.id}:${candidate.thread.session?.status ?? "none"}:${candidate.thread.session?.updatedAt ?? "none"}`;
    if (lastAttemptKeyRef.current === attemptKey) return;
    lastAttemptKeyRef.current = attemptKey;
    void dispatchEntry(candidate.entry, candidate.thread).then((sent) => {
      if (sent) lastAttemptKeyRef.current = null;
    });
  }, [candidate, dispatchEntry]);

  return null;
}
