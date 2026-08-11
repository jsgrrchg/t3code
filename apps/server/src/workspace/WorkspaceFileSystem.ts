// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectMoveEntryInput,
  ProjectMoveEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import { moveWorkspaceEntrySecurely, SecureWorkspaceMoveError } from "./SecureWorkspaceMove.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { ResourceMonitorHostLinuxLibc } from "../resourceTelemetry/ResourceMonitorBinary.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "lstat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "remove",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFoundError extends Schema.TaggedErrorClass<WorkspacePathNotFoundError>()(
  "WorkspacePathNotFoundError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' does not exist: ${this.resolvedPath}`;
  }
}

export class WorkspacePathKindMismatchError extends Schema.TaggedErrorClass<WorkspacePathKindMismatchError>()(
  "WorkspacePathKindMismatchError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' changed kind before it could be deleted: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspacePathNotFoundError,
  WorkspacePathKindMismatchError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceMoveEntryOperationError extends Schema.TaggedErrorClass<WorkspaceMoveEntryOperationError>()(
  "WorkspaceMoveEntryOperationError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "lstat-source",
      "lstat-destination",
      "lstat-destination-parent",
      "link-destination",
      "readlink-source",
      "realpath-workspace-root",
      "realpath-source-parent",
      "realpath-destination-parent",
      "rename",
      "rollback-destination",
      "symlink-destination",
      "unlink-source",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class WorkspaceMoveEntryPathEscapeError extends Schema.TaggedErrorClass<WorkspaceMoveEntryPathEscapeError>()(
  "WorkspaceMoveEntryPathEscapeError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceMoveEntrySourceNotFoundError extends Schema.TaggedErrorClass<WorkspaceMoveEntrySourceNotFoundError>()(
  "WorkspaceMoveEntrySourceNotFoundError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceMoveEntrySourceKindMismatchError extends Schema.TaggedErrorClass<WorkspaceMoveEntrySourceKindMismatchError>()(
  "WorkspaceMoveEntrySourceKindMismatchError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceMoveEntrySamePathError extends Schema.TaggedErrorClass<WorkspaceMoveEntrySamePathError>()(
  "WorkspaceMoveEntrySamePathError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceMoveEntryDestinationExistsError extends Schema.TaggedErrorClass<WorkspaceMoveEntryDestinationExistsError>()(
  "WorkspaceMoveEntryDestinationExistsError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceMoveEntryDestinationParentNotFoundError extends Schema.TaggedErrorClass<WorkspaceMoveEntryDestinationParentNotFoundError>()(
  "WorkspaceMoveEntryDestinationParentNotFoundError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceMoveEntryDestinationParentNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceMoveEntryDestinationParentNotDirectoryError>()(
  "WorkspaceMoveEntryDestinationParentNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    sourceRelativePath: Schema.String,
    destinationRelativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export const WorkspaceMoveEntryError = Schema.Union([
  WorkspaceMoveEntryOperationError,
  WorkspaceMoveEntryPathEscapeError,
  WorkspaceMoveEntrySourceNotFoundError,
  WorkspaceMoveEntrySourceKindMismatchError,
  WorkspaceMoveEntrySamePathError,
  WorkspaceMoveEntryDestinationExistsError,
  WorkspaceMoveEntryDestinationParentNotFoundError,
  WorkspaceMoveEntryDestinationParentNotDirectoryError,
]);
export type WorkspaceMoveEntryError = typeof WorkspaceMoveEntryError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Delete a file, symlink, or directory relative to the workspace root. */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      ProjectDeleteEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Move a file or symlink to another workspace-relative path without intentional overwrite. */
    readonly moveEntry: (
      input: ProjectMoveEntryInput,
    ) => Effect.Effect<
      ProjectMoveEntryResult,
      WorkspaceMoveEntryError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const linuxLibc = hostPlatform === "linux" ? yield* ResourceMonitorHostLinuxLibc : undefined;

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(target.absolutePath),
      catch: (cause) =>
        (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? new WorkspacePathNotFoundError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
            })
          : new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              operationPath: target.absolutePath,
              operation: "lstat",
              cause,
            }),
    });
    const isDirectory = stat.isDirectory();
    if ((input.kind === "directory") !== isDirectory) {
      return yield* new WorkspacePathKindMismatchError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
      });
    }

    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(target.absolutePath, { recursive: isDirectory }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "remove",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath, kind: input.kind };
  });

  const moveEntry: WorkspaceFileSystem["Service"]["moveEntry"] = Effect.fn(
    "WorkspaceFileSystem.moveEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.sourceRelativePath,
    });
    const destination = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.destinationRelativePath,
    });
    const errorContext = {
      workspaceRoot: input.cwd,
      sourceRelativePath: source.relativePath,
      destinationRelativePath: destination.relativePath,
    };

    if (source.absolutePath === destination.absolutePath) {
      return yield* new WorkspaceMoveEntrySamePathError({
        ...errorContext,
        resolvedPath: source.absolutePath,
      });
    }

    yield* Effect.tryPromise({
      try: () =>
        moveWorkspaceEntrySecurely({
          platform: hostPlatform,
          architecture: hostArchitecture,
          ...(linuxLibc === undefined ? {} : { linuxLibc }),
          workspaceRoot: input.cwd,
          sourceRelativePath: source.relativePath,
          destinationRelativePath: destination.relativePath,
        }),
      catch: (cause) => {
        if (!(cause instanceof SecureWorkspaceMoveError)) {
          return new WorkspaceMoveEntryOperationError({
            ...errorContext,
            resolvedPath: destination.absolutePath,
            operationPath: destination.absolutePath,
            operation: "rename",
            cause,
          });
        }
        switch (cause.failure) {
          case "path-escape":
            return new WorkspaceMoveEntryPathEscapeError({
              ...errorContext,
              resolvedWorkspaceRoot: input.cwd,
              resolvedPath: cause.operationPath,
            });
          case "source-not-found":
            return new WorkspaceMoveEntrySourceNotFoundError({
              ...errorContext,
              resolvedPath: cause.operationPath,
            });
          case "source-kind-mismatch":
            return new WorkspaceMoveEntrySourceKindMismatchError({
              ...errorContext,
              resolvedPath: cause.operationPath,
            });
          case "destination-exists":
            return new WorkspaceMoveEntryDestinationExistsError({
              ...errorContext,
              resolvedPath: cause.operationPath,
            });
          case "destination-parent-not-found":
            return new WorkspaceMoveEntryDestinationParentNotFoundError({
              ...errorContext,
              resolvedPath: cause.operationPath,
            });
          case "destination-parent-not-directory":
            return new WorkspaceMoveEntryDestinationParentNotDirectoryError({
              ...errorContext,
              resolvedPath: cause.operationPath,
            });
          case "operation-failed":
          case "unsupported-platform":
            return new WorkspaceMoveEntryOperationError({
              ...errorContext,
              resolvedPath: destination.absolutePath,
              operationPath: cause.operationPath,
              operation: "rename",
              cause,
            });
        }
      },
    });
    yield* workspaceEntries.refresh(input.cwd);
    return {
      sourceRelativePath: source.relativePath,
      destinationRelativePath: destination.relativePath,
      kind: input.kind,
    };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ deleteEntry, moveEntry, readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
