import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  const searchEntries = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:projects:search-entries",
    tag: WS_METHODS.projectsSearchEntries,
    // File search surfaces are transient. Revalidate when they mount so a
    // workspace refresh from the previous turn is visible immediately.
    staleTimeMs: 0,
  });
  const listEntries = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:projects:list-entries",
    tag: WS_METHODS.projectsListEntries,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  });
  const readFile = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:projects:read-file",
    tag: WS_METHODS.projectsReadFile,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  });
  return {
    searchEntries,
    listEntries,
    readFile,
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    deleteEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:delete-entry",
      tag: WS_METHODS.projectsDeleteEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(listEntries({ environmentId, input: { cwd: input.cwd } }));
          registry.refresh(
            listEntries({ environmentId, input: { cwd: input.cwd, includeIgnored: true } }),
          );
          registry.refresh(
            readFile({
              environmentId,
              input: { cwd: input.cwd, relativePath: input.relativePath },
            }),
          );
        }),
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
    }),
  };
}
