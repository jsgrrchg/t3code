import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-09T12:00:00.000Z";
const projectId = ProjectId.make("project-provider-actions");
const threadId = ThreadId.make("thread-provider-actions");

const seedReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-project-provider-actions"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project-provider-actions"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-provider-actions"),
    metadata: {},
    payload: {
      projectId,
      title: "Provider actions",
      workspaceRoot: "/tmp/provider-actions",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-provider-actions"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread-provider-actions"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-provider-actions"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Provider actions",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      interactionMode: "default",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("decider provider actions", (it) => {
  it.effect("persists a native review request without creating a user message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.provider-action.run",
          commandId: CommandId.make("command-review-branch"),
          threadId,
          action: { type: "review", target: { type: "baseBranch", branch: "main" } },
          createdAt: now,
        },
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.provider-action-requested");
      expect(events[0]?.payload).toEqual({
        threadId,
        action: { type: "review", target: { type: "baseBranch", branch: "main" } },
        createdAt: now,
      });
    }),
  );
});
