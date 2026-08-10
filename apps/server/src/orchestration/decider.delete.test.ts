import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("creates panel chats only below an existing top-level thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const createChild = {
        type: "thread.create",
        commandId: asCommandId("cmd-panel-chat-create"),
        threadId: asThreadId("thread-panel-chat"),
        projectId: asProjectId("project-delete"),
        parentThreadId: asThreadId("thread-delete-1"),
        title: "New chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      } satisfies Extract<OrchestrationCommand, { type: "thread.create" }>;

      const created = yield* decideOrchestrationCommand({ command: createChild, readModel });
      expect(Array.isArray(created)).toBe(false);
      if (!("type" in created) || created.type !== "thread.created") return;
      const createdEvent = created as Extract<OrchestrationEvent, { type: "thread.created" }>;
      expect(createdEvent.payload.parentThreadId).toBe(asThreadId("thread-delete-1"));

      const withChild = yield* projectEvent(readModel, {
        ...createdEvent,
        sequence: 4,
      } as OrchestrationEvent);
      const nestedError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...createChild,
            commandId: asCommandId("cmd-panel-chat-nested"),
            threadId: asThreadId("thread-panel-chat-nested"),
            parentThreadId: createChild.threadId,
          },
          readModel: withChild,
        }),
      );
      expect(nestedError.message).toContain("cannot own nested panel chats");
    }),
  );

  it.effect("rejects missing, deleted, and cross-project panel chat parents", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const baseCommand = {
        type: "thread.create",
        commandId: asCommandId("cmd-panel-chat-invalid-parent"),
        threadId: asThreadId("thread-panel-chat-invalid"),
        projectId: asProjectId("project-delete"),
        parentThreadId: asThreadId("thread-missing"),
        title: "New chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      } satisfies Extract<OrchestrationCommand, { type: "thread.create" }>;

      const missingError = yield* Effect.flip(
        decideOrchestrationCommand({ command: baseCommand, readModel }),
      );
      expect(missingError.message).toContain("does not exist");

      const withDeletedParent = yield* projectEvent(readModel, {
        sequence: 4,
        eventId: asEventId("evt-parent-delete"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-delete-1"),
        type: "thread.deleted",
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: asCommandId("cmd-parent-delete"),
        causationEventId: null,
        correlationId: asCommandId("cmd-parent-delete"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-delete-1"),
          deletedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      const deletedError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: { ...baseCommand, parentThreadId: asThreadId("thread-delete-1") },
          readModel: withDeletedParent,
        }),
      );
      expect(deletedError.message).toContain("is deleted");

      const withOtherProject = yield* projectEvent(readModel, {
        sequence: 4,
        eventId: asEventId("evt-other-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-other"),
        type: "project.created",
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: asCommandId("cmd-other-project-create"),
        causationEventId: null,
        correlationId: asCommandId("cmd-other-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-other"),
          title: "Other Project",
          workspaceRoot: "/tmp/project-other",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      const crossProjectError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...baseCommand,
            projectId: asProjectId("project-other"),
            parentThreadId: asThreadId("thread-delete-1"),
          },
          readModel: withOtherProject,
        }),
      );
      expect(crossProjectError.message).toContain("different project");
    }),
  );

  it.effect("deletes panel chat children before their parent", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const childCreated = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-panel-chat-create"),
          threadId: asThreadId("thread-panel-chat"),
          projectId: asProjectId("project-delete"),
          parentThreadId: asThreadId("thread-delete-1"),
          title: "New chat",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        readModel,
      });
      if (!("type" in childCreated)) return;
      const withChild = yield* projectEvent(readModel, {
        ...childCreated,
        sequence: 4,
      } as OrchestrationEvent);
      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-parent-delete"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: withChild,
      });

      expect(normalizeDeleteEvent(deleted).map((event) => event.payload)).toEqual([
        { threadId: asThreadId("thread-panel-chat") },
        { threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("deletes an individual panel chat without deleting its parent", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const childCreated = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-panel-chat-create-individual"),
          threadId: asThreadId("thread-panel-chat-individual"),
          projectId: asProjectId("project-delete"),
          parentThreadId: asThreadId("thread-delete-1"),
          title: "New chat",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        readModel,
      });
      if (!("type" in childCreated)) return;
      const withChild = yield* projectEvent(readModel, {
        ...childCreated,
        sequence: 4,
      } as OrchestrationEvent);
      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-panel-chat-delete-individual"),
          threadId: asThreadId("thread-panel-chat-individual"),
        },
        readModel: withChild,
      });

      expect(normalizeDeleteEvent(deleted).map((event) => event.payload)).toEqual([
        { threadId: asThreadId("thread-panel-chat-individual") },
      ]);
    }),
  );

  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );
});
