import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  type DesktopQueuedFollowUp,
  queuedFollowUpsForThread,
  reloadDesktopFollowUpQueueForTest,
  useDesktopFollowUpQueueStore,
  writeDesktopFollowUpQueueStorageForTest,
} from "./desktopFollowUpQueueStore";

function queuedFollowUp(index: number, threadId = "thread-1"): DesktopQueuedFollowUp {
  return {
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
});
