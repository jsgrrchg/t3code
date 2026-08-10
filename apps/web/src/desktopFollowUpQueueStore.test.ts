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
  type DesktopQueuedMessageFollowUp,
  type DesktopQueuedProviderAction,
  queuedFollowUpsForThread,
  reloadDesktopFollowUpQueueForTest,
  shouldQueueDesktopFollowUp,
  useDesktopFollowUpQueueStore,
  writeDesktopFollowUpQueueStorageForTest,
} from "./desktopFollowUpQueueStore";

function queuedFollowUp(index: number, threadId = "thread-1"): DesktopQueuedMessageFollowUp {
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

function queuedProviderAction(index: number, threadId = "thread-1"): DesktopQueuedProviderAction {
  return {
    kind: "provider-action",
    id: `action-${index}`,
    commandId: CommandId.make(`action-command-${index}`),
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make(threadId),
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

  it("edits a queued message atomically and persists the updated text", () => {
    const entry = queuedFollowUp(1);
    const store = useDesktopFollowUpQueueStore.getState();
    store.enqueue(entry);

    expect(store.beginEdit(entry.id)).toBe(true);
    expect(useDesktopFollowUpQueueStore.getState().editingEntryId).toBe(entry.id);
    expect(useDesktopFollowUpQueueStore.getState().claim(entry.id)).toBe(false);
    expect(
      useDesktopFollowUpQueueStore.getState().updateMessageText(entry.id, "Edited follow-up"),
    ).toBe(true);
    expect(useDesktopFollowUpQueueStore.getState().editingEntryId).toBeNull();

    useDesktopFollowUpQueueStore.setState({ entries: [] });
    reloadDesktopFollowUpQueueForTest();
    expect(useDesktopFollowUpQueueStore.getState().entries).toEqual([
      expect.objectContaining({ id: entry.id, text: "Edited follow-up" }),
    ]);
  });

  it("cancels edits without changing the queued message", () => {
    const entry = queuedFollowUp(1);
    const store = useDesktopFollowUpQueueStore.getState();
    store.enqueue(entry);

    expect(store.beginEdit(entry.id)).toBe(true);
    useDesktopFollowUpQueueStore.getState().cancelEdit(entry.id);

    expect(useDesktopFollowUpQueueStore.getState().editingEntryId).toBeNull();
    expect(useDesktopFollowUpQueueStore.getState().entries[0]).toEqual(
      expect.objectContaining({ text: entry.text }),
    );
    expect(useDesktopFollowUpQueueStore.getState().claim(entry.id)).toBe(true);
  });

  it("only edits message entries and keeps non-attachment messages non-empty", () => {
    const message = queuedFollowUp(1);
    const action = queuedProviderAction(1);
    const store = useDesktopFollowUpQueueStore.getState();
    store.enqueue(message);
    store.enqueue(action);

    expect(store.beginEdit(action.id)).toBe(false);
    expect(store.beginEdit(message.id)).toBe(true);
    expect(useDesktopFollowUpQueueStore.getState().updateMessageText(message.id, "   ")).toBe(
      false,
    );
    expect(useDesktopFollowUpQueueStore.getState().editingEntryId).toBe(message.id);
    expect(useDesktopFollowUpQueueStore.getState().entries[0]).toEqual(
      expect.objectContaining({ text: message.text }),
    );
  });

  it("reorders one thread without moving interleaved entries from another thread", () => {
    const first = queuedFollowUp(1);
    const otherThread = queuedFollowUp(2, "thread-2");
    const last = queuedFollowUp(3);
    const store = useDesktopFollowUpQueueStore.getState();
    store.enqueue(first);
    store.enqueue(otherThread);
    store.enqueue(last);

    expect(store.reorder(last.id, first.id)).toBe(true);
    expect(useDesktopFollowUpQueueStore.getState().entries.map((entry) => entry.id)).toEqual([
      last.id,
      otherThread.id,
      first.id,
    ]);

    useDesktopFollowUpQueueStore.setState({ entries: [] });
    reloadDesktopFollowUpQueueForTest();
    expect(useDesktopFollowUpQueueStore.getState().entries.map((entry) => entry.id)).toEqual([
      last.id,
      otherThread.id,
      first.id,
    ]);
  });

  it("reorders messages and provider actions as one queue", () => {
    const first = queuedFollowUp(1);
    const action = queuedProviderAction(1);
    const last = queuedFollowUp(2);
    const store = useDesktopFollowUpQueueStore.getState();
    store.enqueue(first);
    store.enqueue(action);
    store.enqueue(last);

    expect(store.reorder(action.id, first.id)).toBe(true);
    expect(useDesktopFollowUpQueueStore.getState().entries.map((entry) => entry.id)).toEqual([
      action.id,
      first.id,
      last.id,
    ]);
  });

  it("rejects cross-thread moves and reordering a queue with an active claim", () => {
    const first = queuedFollowUp(1);
    const second = queuedFollowUp(2);
    const otherThread = queuedProviderAction(1, "thread-2");
    const store = useDesktopFollowUpQueueStore.getState();
    store.enqueue(first);
    store.enqueue(second);
    store.enqueue(otherThread);

    expect(store.reorder(first.id, otherThread.id)).toBe(false);
    expect(store.claim(first.id)).toBe(true);
    expect(store.reorder(second.id, first.id)).toBe(false);
    expect(useDesktopFollowUpQueueStore.getState().entries.map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
      otherThread.id,
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
