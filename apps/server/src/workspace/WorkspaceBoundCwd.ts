import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";

export class WorkspaceCwdCanonicalizationError extends Data.TaggedError(
  "WorkspaceCwdCanonicalizationError",
)<{
  readonly resolvedPath: string;
  readonly cause: PlatformError.PlatformError;
}> {}

export class WorkspaceCwdOutsideRootsError extends Data.TaggedError(
  "WorkspaceCwdOutsideRootsError",
)<{
  readonly cwd: string;
}> {}

export interface WorkspaceBoundCwdOptions {
  readonly workspaceRoot?: string;
  readonly includeManagedWorktrees?: boolean;
}

export const makeAssertWorkspaceBoundCwd = Effect.fn("makeAssertWorkspaceBoundCwd")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(new WorkspaceCwdCanonicalizationError({ resolvedPath, cause })),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const findGitMarker = Effect.fn("WorkspaceBoundCwd.findGitMarker")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const marker = path.join(current, ".git");
      const markerInfo = yield* fileSystem.stat(marker).pipe(Effect.orElseSucceed(() => null));
      if (markerInfo?.type === "Directory" || markerInfo?.type === "File") {
        return { marker, type: markerInfo.type } as const;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  });

  const resolveGitCommonDir = Effect.fn("WorkspaceBoundCwd.resolveGitCommonDir")(function* (
    cwd: string,
  ) {
    const marker = yield* findGitMarker(cwd);
    if (marker === null) return null;

    if (marker.type === "Directory") {
      return yield* fileSystem.realPath(marker.marker);
    }

    const markerContents = (yield* fileSystem.readFileString(marker.marker)).trim();
    if (!markerContents.startsWith("gitdir:")) return null;
    const gitDirValue = markerContents.slice("gitdir:".length).trim();
    if (gitDirValue.length === 0) return null;

    const gitDir = yield* fileSystem.realPath(
      path.resolve(path.dirname(marker.marker), gitDirValue),
    );
    const commonDirValue = (yield* fileSystem.readFileString(
      path.join(gitDir, "commondir"),
    )).trim();
    if (commonDirValue.length === 0) return null;

    // A linked worktree has a backlink from its private Git directory to the
    // worktree's .git file. Requiring it prevents an unrelated directory from
    // opting into the workspace boundary with a fabricated .git pointer.
    const backlinkValue = (yield* fileSystem.readFileString(path.join(gitDir, "gitdir"))).trim();
    const [markerPath, backlinkPath] = yield* Effect.all([
      fileSystem.realPath(marker.marker),
      fileSystem.realPath(path.resolve(gitDir, backlinkValue)),
    ]);
    if (markerPath !== backlinkPath) return null;

    return yield* fileSystem.realPath(path.resolve(gitDir, commonDirValue));
  });

  const isLinkedGitWorktree = (candidate: string, workspaceRoot: string) =>
    Effect.all([resolveGitCommonDir(candidate), resolveGitCommonDir(workspaceRoot)]).pipe(
      Effect.map(
        ([candidateCommonDir, workspaceCommonDir]) =>
          candidateCommonDir !== null && candidateCommonDir === workspaceCommonDir,
      ),
      Effect.orElseSucceed(() => false),
    );

  return Effect.fn("WorkspaceBoundCwd.assert")(function* (
    cwd: string,
    options: WorkspaceBoundCwdOptions = {},
  ) {
    const configuredWorkspaceRoot = options.workspaceRoot ?? config.cwd;
    const includeManagedWorktrees = options.includeManagedWorktrees ?? true;
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(configuredWorkspaceRoot),
      canonicalizePath(config.worktreesDir),
    ]);

    if (
      isWithinRoot(candidate, workspaceRoot) ||
      (includeManagedWorktrees && isWithinRoot(candidate, worktreesRoot)) ||
      (yield* isLinkedGitWorktree(candidate, workspaceRoot))
    ) {
      return;
    }

    return yield* new WorkspaceCwdOutsideRootsError({ cwd });
  });
});
