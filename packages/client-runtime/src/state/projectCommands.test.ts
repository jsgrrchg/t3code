import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createProjectEnvironmentAtoms,
  projectEntryParentDirectory,
  projectMoveListRefreshInputs,
} from "./projectCommands.ts";

const environmentId = EnvironmentId.make("environment-1");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const connectedState: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeRuntime = Effect.fn("projectCommandsTest.makeRuntime")(function* (
  client: WsRpcProtocolClient,
) {
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(connectedState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  return Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  ) as unknown as Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto, never>;
});

describe("project move cache targets", () => {
  it("derives POSIX parent directories", () => {
    expect(projectEntryParentDirectory("index.ts")).toBeUndefined();
    expect(projectEntryParentDirectory("src/index.ts")).toBe("src");
    expect(projectEntryParentDirectory("src/components/index.ts")).toBe("src/components");
  });

  it("refreshes root and unique source/destination parents with ignored variants", () => {
    expect(
      projectMoveListRefreshInputs({
        cwd: "/repo",
        sourceRelativePath: "src/index.ts",
        destinationRelativePath: "components/index.ts",
        kind: "file",
      }),
    ).toEqual([
      { cwd: "/repo" },
      { cwd: "/repo", includeIgnored: true },
      { cwd: "/repo", directory: "src" },
      { cwd: "/repo", directory: "src", includeIgnored: true },
      { cwd: "/repo", directory: "components" },
      { cwd: "/repo", directory: "components", includeIgnored: true },
    ]);
  });
});

describe("project move command", () => {
  it.effect("serializes moves within one environment workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const client = {
          [WS_METHODS.projectsMoveEntry]: (input: {
            sourceRelativePath: string;
            destinationRelativePath: string;
          }) =>
            Effect.gen(function* () {
              const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
              if (call === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              return { ...input, kind: "file" as const };
            }),
        } as unknown as WsRpcProtocolClient;
        const runtime = yield* makeRuntime(client);
        const atoms = createProjectEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const first = atoms.moveEntry.run(registry, {
          environmentId,
          input: {
            cwd: "/repo",
            sourceRelativePath: "one.ts",
            destinationRelativePath: "folder/one.ts",
            kind: "file",
          },
        });
        yield* Deferred.await(firstStarted);
        const second = atoms.moveEntry.run(registry, {
          environmentId,
          input: {
            cwd: "/repo",
            sourceRelativePath: "two.ts",
            destinationRelativePath: "folder/two.ts",
            kind: "file",
          },
        });
        yield* Effect.yieldNow;
        expect(yield* Ref.get(calls)).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        const results = yield* Effect.promise(() => Promise.all([first, second]));

        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );
});
