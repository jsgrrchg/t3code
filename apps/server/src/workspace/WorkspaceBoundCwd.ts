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

  return Effect.fn("WorkspaceBoundCwd.assert")(function* (cwd: string) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new WorkspaceCwdOutsideRootsError({ cwd });
  });
});
