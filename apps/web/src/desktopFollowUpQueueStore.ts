import {
  CommandId,
  EnvironmentId,
  type FollowUpMessageBehavior,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderThreadAction,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { createMemoryStorage, isStateStorage } from "./lib/storage";

export const DESKTOP_FOLLOW_UP_QUEUE_STORAGE_KEY = "t3code:desktop-follow-up-queue:v1";
const MAX_QUEUED_FOLLOW_UPS = 50;

const QueuedUploadImage = Schema.Struct({
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

const DesktopQueuedFollowUpBase = {
  id: Schema.String,
  commandId: CommandId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  createdAt: Schema.String,
};

export const DesktopQueuedMessageFollowUp = Schema.Struct({
  ...DesktopQueuedFollowUpBase,
  kind: Schema.Literal("message").pipe(Schema.withDecodingDefaultKey(Effect.succeed("message"))),
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(QueuedUploadImage),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  titleSeed: Schema.String,
  branch: Schema.optionalKey(Schema.String),
});
export type DesktopQueuedMessageFollowUp = typeof DesktopQueuedMessageFollowUp.Type;

export const DesktopQueuedProviderAction = Schema.Struct({
  ...DesktopQueuedFollowUpBase,
  kind: Schema.Literal("provider-action"),
  action: ProviderThreadAction,
});
export type DesktopQueuedProviderAction = typeof DesktopQueuedProviderAction.Type;

export const DesktopQueuedFollowUp = Schema.Union([
  DesktopQueuedMessageFollowUp,
  DesktopQueuedProviderAction,
]);
export type DesktopQueuedFollowUp = typeof DesktopQueuedFollowUp.Type;

const PersistedDesktopFollowUpQueue = Schema.Struct({
  entries: Schema.Array(DesktopQueuedFollowUp),
});
const decodePersistedQueue = Schema.decodeUnknownSync(PersistedDesktopFollowUpQueue);

interface SynchronousQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStorage(): SynchronousQueueStorage {
  try {
    if (typeof localStorage !== "undefined" && isStateStorage(localStorage)) {
      return localStorage as SynchronousQueueStorage;
    }
  } catch {
    // Sandboxed/browser-policy fallback. The queue remains usable for this session.
  }
  return createMemoryStorage() as SynchronousQueueStorage;
}

const queueStorage = resolveStorage();

function readEntries(): ReadonlyArray<DesktopQueuedFollowUp> {
  try {
    const raw = queueStorage.getItem(DESKTOP_FOLLOW_UP_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return decodePersistedQueue(parsed).entries;
  } catch {
    return [];
  }
}

function persistEntries(entries: ReadonlyArray<DesktopQueuedFollowUp>): boolean {
  try {
    queueStorage.setItem(DESKTOP_FOLLOW_UP_QUEUE_STORAGE_KEY, JSON.stringify({ entries }));
    return true;
  } catch (error) {
    console.error("[DESKTOP-FOLLOW-UP-QUEUE] Could not persist queued follow-up.", error);
    return false;
  }
}

interface DesktopFollowUpQueueState {
  readonly entries: ReadonlyArray<DesktopQueuedFollowUp>;
  readonly dispatchingEntryId: string | null;
  enqueue: (entry: DesktopQueuedFollowUp) => boolean;
  remove: (entryId: string) => void;
  claim: (entryId: string) => boolean;
  release: (entryId: string) => void;
}

export const useDesktopFollowUpQueueStore = create<DesktopFollowUpQueueState>()((set, get) => ({
  entries: readEntries(),
  dispatchingEntryId: null,
  enqueue: (entry) => {
    if (get().entries.length >= MAX_QUEUED_FOLLOW_UPS) return false;
    const nextEntries = [...get().entries, entry];
    if (!persistEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  remove: (entryId) => {
    const nextEntries = get().entries.filter((entry) => entry.id !== entryId);
    persistEntries(nextEntries);
    set((state) => ({
      entries: nextEntries,
      dispatchingEntryId: state.dispatchingEntryId === entryId ? null : state.dispatchingEntryId,
    }));
  },
  claim: (entryId) => {
    if (get().dispatchingEntryId !== null) return false;
    if (!get().entries.some((entry) => entry.id === entryId)) return false;
    set({ dispatchingEntryId: entryId });
    return true;
  },
  release: (entryId) => {
    set((state) => ({
      dispatchingEntryId: state.dispatchingEntryId === entryId ? null : state.dispatchingEntryId,
    }));
  },
}));

export function queuedFollowUpsForThread(
  entries: ReadonlyArray<DesktopQueuedFollowUp>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<DesktopQueuedFollowUp> {
  return entries.filter(
    (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
  );
}

/** After an interruption, the next manual message starts a new turn instead of joining the queue. */
export function shouldQueueDesktopFollowUp(input: {
  readonly desktop: boolean;
  readonly serverThread: boolean;
  readonly phase: string;
  readonly behavior: FollowUpMessageBehavior;
}): boolean {
  return (
    input.desktop && input.serverThread && input.phase === "running" && input.behavior === "queue"
  );
}

/** An interrupted turn keeps queued work paused until a later manual turn finishes. */
export function canDispatchDesktopQueuedFollowUp(input: {
  readonly sessionStatus: string | null;
  readonly latestTurnState: string | null;
}): boolean {
  return (
    input.sessionStatus !== "running" &&
    input.sessionStatus !== "starting" &&
    input.latestTurnState !== "interrupted"
  );
}

export function writeDesktopFollowUpQueueStorageForTest(raw: string): void {
  if (raw) queueStorage.setItem(DESKTOP_FOLLOW_UP_QUEUE_STORAGE_KEY, raw);
  else queueStorage.removeItem(DESKTOP_FOLLOW_UP_QUEUE_STORAGE_KEY);
  useDesktopFollowUpQueueStore.setState({ entries: readEntries(), dispatchingEntryId: null });
}

export function reloadDesktopFollowUpQueueForTest(): void {
  useDesktopFollowUpQueueStore.setState({ entries: readEntries(), dispatchingEntryId: null });
}
