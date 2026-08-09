import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  canDispatchDesktopQueuedFollowUp,
  type DesktopQueuedFollowUp,
  type DesktopQueuedProviderAction,
  queuedFollowUpsForThread,
  reloadDesktopFollowUpQueueForTest,
  shouldQueueDesktopFollowUp,
  useDesktopFollowUpQueueStore,
  writeDesktopFollowUpQueueStorageForTest,
} from "./desktopFollowUpQueueStore";

function queuedFollowUp(index: number, threadId = "thread-1"): DesktopQueuedFollowUp {
  return {
    kind: "message",
    id: `queue-${index}`,
    commandId: CommandId.make(`command-${index}`),
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(`message-${index}`),
    text: `Follow-up ${index}`,
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    titleSeed: `Follow-up ${index}`,
    createdAt: `2026-08-09T00:00:0${index}.000Z`,
  };
}

function queuedProviderAction(index: number): DesktopQueuedProviderAction {
  return {
    kind: "provider-action",
    id: `action-${index}`,
    commandId: CommandId.make(`action-command-${index}`),
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    action: { type: "compact" },
    createdAt: `2026-08-09T00:00:1${index}.000Z`,
  };
}

describe("desktop follow-up queue", () => {
  beforeEach(() => {
    writeDesktopFollowUpQueueStorageForTest("");
  });

  it("keeps FIFO order per environment thread", () => {
    const store = useDesktopFollowUpQueueStore.getState();
    expect(store.enqueue(queuedFollowUp(1))).toBe(true);
    expect(store.enqueue(queuedFollowUp(2, "thread-2"))).toBe(true);
    expect(store.enqueue(queuedFollowUp(3))).toBe(true);

    expect(
      queuedFollowUpsForThread(
        useDesktopFollowUpQueueStore.getState().entries,
        EnvironmentId.make("environment-1"),
        ThreadId.make("thread-1"),
      ).map((entry) => entry.id),
    ).toEqual(["queue-1", "queue-3"]);
  });

  it("allows only one dispatch claim and releases it safely", () => {
    const entry = queuedFollowUp(1);
    useDesktopFollowUpQueueStore.getState().enqueue(entry);

    expect(useDesktopFollowUpQueueStore.getState().claim(entry.id)).toBe(true);
    expect(useDesktopFollowUpQueueStore.getState().claim(entry.id)).toBe(false);
    useDesktopFollowUpQueueStore.getState().release(entry.id);
    expect(useDesktopFollowUpQueueStore.getState().claim(entry.id)).toBe(true);
  });

  it("removes a queued follow-up and persists the remaining list", () => {
    const first = queuedFollowUp(1);
    const second = queuedFollowUp(2);
    useDesktopFollowUpQueueStore.getState().enqueue(first);
    useDesktopFollowUpQueueStore.getState().enqueue(second);
    useDesktopFollowUpQueueStore.getState().remove(first.id);

    useDesktopFollowUpQueueStore.setState({ entries: [] });
    reloadDesktopFollowUpQueueForTest();

    expect(useDesktopFollowUpQueueStore.getState().entries.map((entry) => entry.id)).toEqual([
      second.id,
    ]);
  });

  it("decodes legacy message entries without a kind", () => {
    const legacyEntry = { ...queuedFollowUp(1), kind: undefined };
    writeDesktopFollowUpQueueStorageForTest(JSON.stringify({ entries: [legacyEntry] }));

    expect(useDesktopFollowUpQueueStore.getState().entries).toEqual([
      expect.objectContaining({
        kind: "message",
        id: legacyEntry.id,
      }),
    ]);
  });

  it("persists provider actions alongside messages in FIFO order", () => {
    const message = queuedFollowUp(1);
    const action = queuedProviderAction(1);
    const store = useDesktopFollowUpQueueStore.getState();

    expect(store.enqueue(message)).toBe(true);
    expect(store.enqueue(action)).toBe(true);

    useDesktopFollowUpQueueStore.setState({ entries: [] });
    reloadDesktopFollowUpQueueForTest();

    expect(
      useDesktopFollowUpQueueStore.getState().entries.map((entry) => [entry.kind, entry.id]),
    ).toEqual([
      ["message", message.id],
      ["provider-action", action.id],
    ]);
  });

  it("sends a manual message directly after an interrupted turn", () => {
    expect(
      shouldQueueDesktopFollowUp({
        desktop: true,
        serverThread: true,
        phase: "disconnected",
        behavior: "queue",
      }),
    ).toBe(false);
    expect(
      shouldQueueDesktopFollowUp({
        desktop: true,
        serverThread: true,
        phase: "running",
        behavior: "queue",
      }),
    ).toBe(true);
  });

  it("resumes queued work only after the manual turn finishes", () => {
    expect(
      canDispatchDesktopQueuedFollowUp({
        sessionStatus: "interrupted",
        latestTurnState: "interrupted",
      }),
    ).toBe(false);
    expect(
      canDispatchDesktopQueuedFollowUp({
        sessionStatus: "running",
        latestTurnState: "running",
      }),
    ).toBe(false);
    expect(
      canDispatchDesktopQueuedFollowUp({
        sessionStatus: "ready",
        latestTurnState: "completed",
      }),
    ).toBe(true);
  });
});
