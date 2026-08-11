// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });

  describe("deleteEntry", () => {
    it.effect("deletes files and refreshes workspace entries", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/delete-me.ts", "export {};\n");

        expect((yield* workspaceEntries.list({ cwd })).entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "src/delete-me.ts" })]),
        );
        const result = yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "src/delete-me.ts",
          kind: "file",
        });

        expect(result).toEqual({ relativePath: "src/delete-me.ts", kind: "file" });
        expect((yield* workspaceEntries.list({ cwd })).entries).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "src/delete-me.ts" })]),
        );
      }),
    );

    it.effect("recursively deletes non-empty directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "generated/nested/output.txt", "generated\n");

        const result = yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "generated",
          kind: "directory",
        });
        const deleted = yield* fileSystem
          .stat(path.join(cwd, "generated"))
          .pipe(Effect.orElseSucceed(() => null));

        expect(result).toEqual({ relativePath: "generated", kind: "directory" });
        expect(deleted).toBeNull();
      }),
    );

    it.effect("rejects deletion outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "../outside", kind: "directory" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("rejects stale entry kinds", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "changed-kind", "file\n");

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "changed-kind", kind: "directory" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathKindMismatchError);
      }),
    );

    it.effect("deletes symlinks without following targets outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "keep.txt", "keep\n");
        yield* fileSystem.symlink(path.join(outsideDir, "keep.txt"), path.join(cwd, "linked.txt"));

        yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "linked.txt",
          kind: "file",
        });

        expect(yield* fileSystem.readFileString(path.join(outsideDir, "keep.txt"))).toBe("keep\n");
        expect(
          yield* fileSystem
            .stat(path.join(cwd, "linked.txt"))
            .pipe(Effect.orElseSucceed(() => null)),
        ).toBeNull();
      }),
    );
  });

  describe("moveEntry", () => {
    it.effect("moves files between folders and refreshes workspace entries", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");
        yield* fileSystem.makeDirectory(path.join(cwd, "components"));
        yield* workspaceEntries.list({ cwd });

        const result = yield* workspaceFileSystem.moveEntry({
          cwd,
          sourceRelativePath: "src/index.ts",
          destinationRelativePath: "components/index.ts",
          kind: "file",
        });

        expect(result).toEqual({
          sourceRelativePath: "src/index.ts",
          destinationRelativePath: "components/index.ts",
          kind: "file",
        });
        expect(yield* fileSystem.readFileString(path.join(cwd, "components/index.ts"))).toBe(
          "export const answer = 42;\n",
        );
        expect(
          yield* fileSystem.stat(path.join(cwd, "src/index.ts")).pipe(Effect.option),
        ).toMatchObject({ _tag: "None" });
        const entries = (yield* workspaceEntries.list({ cwd })).entries;
        expect(entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "components/index.ts" })]),
        );
        expect(entries).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "src/index.ts" })]),
        );
      }),
    );

    it.effect("moves a nested file to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "nested/readme.md", "hello\n");

        yield* workspaceFileSystem.moveEntry({
          cwd,
          sourceRelativePath: "nested/readme.md",
          destinationRelativePath: "readme.md",
          kind: "file",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "readme.md"))).toBe("hello\n");
      }),
    );

    it.effect("rejects missing, directory, no-op, and colliding sources", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "source.txt", "source\n");
        yield* writeTextFile(cwd, "destination.txt", "destination\n");
        yield* fileSystem.makeDirectory(path.join(cwd, "directory"));

        const missing = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "missing.txt",
            destinationRelativePath: "moved.txt",
            kind: "file",
          })
          .pipe(Effect.flip);
        expect(missing).toBeInstanceOf(WorkspaceFileSystem.WorkspaceMoveEntrySourceNotFoundError);

        const directory = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "directory",
            destinationRelativePath: "moved-directory",
            kind: "file",
          })
          .pipe(Effect.flip);
        expect(directory).toBeInstanceOf(
          WorkspaceFileSystem.WorkspaceMoveEntrySourceKindMismatchError,
        );

        const same = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "./source.txt",
            destinationRelativePath: "source.txt",
            kind: "file",
          })
          .pipe(Effect.flip);
        expect(same).toBeInstanceOf(WorkspaceFileSystem.WorkspaceMoveEntrySamePathError);

        const collision = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "source.txt",
            destinationRelativePath: "destination.txt",
            kind: "file",
          })
          .pipe(Effect.flip);
        expect(collision).toBeInstanceOf(
          WorkspaceFileSystem.WorkspaceMoveEntryDestinationExistsError,
        );
        expect(yield* fileSystem.readFileString(path.join(cwd, "source.txt"))).toBe("source\n");
        expect(yield* fileSystem.readFileString(path.join(cwd, "destination.txt"))).toBe(
          "destination\n",
        );
      }),
    );

    it.effect("rejects invalid destination parents and path traversal", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "source.txt", "source\n");
        yield* writeTextFile(cwd, "not-a-directory", "file\n");

        const missingParent = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "source.txt",
            destinationRelativePath: "missing/moved.txt",
            kind: "file",
          })
          .pipe(Effect.flip);
        expect(missingParent).toBeInstanceOf(
          WorkspaceFileSystem.WorkspaceMoveEntryDestinationParentNotFoundError,
        );

        const fileParent = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "source.txt",
            destinationRelativePath: "not-a-directory/moved.txt",
            kind: "file",
          })
          .pipe(Effect.flip);
        expect(fileParent).toBeInstanceOf(
          WorkspaceFileSystem.WorkspaceMoveEntryDestinationParentNotDirectoryError,
        );

        for (const [sourceRelativePath, destinationRelativePath] of [
          ["../source.txt", "moved.txt"],
          ["source.txt", "../moved.txt"],
        ] as const) {
          const traversal = yield* workspaceFileSystem
            .moveEntry({ cwd, sourceRelativePath, destinationRelativePath, kind: "file" })
            .pipe(Effect.flip);
          expect(traversal).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        }
      }),
    );

    it.effect("rejects destination parents resolving outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(cwd, "source.txt", "source\n");
        yield* fileSystem.symlink(outsideDir, path.join(cwd, "outside"));

        const error = yield* workspaceFileSystem
          .moveEntry({
            cwd,
            sourceRelativePath: "source.txt",
            destinationRelativePath: "outside/moved.txt",
            kind: "file",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceMoveEntryPathEscapeError);
      }),
    );

    it.effect("moves symlinks without moving their external targets", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const target = path.join(outsideDir, "keep.txt");
        yield* writeTextFile(outsideDir, "keep.txt", "keep\n");
        yield* fileSystem.makeDirectory(path.join(cwd, "links"));
        yield* fileSystem.symlink(target, path.join(cwd, "linked.txt"));

        yield* workspaceFileSystem.moveEntry({
          cwd,
          sourceRelativePath: "linked.txt",
          destinationRelativePath: "links/linked.txt",
          kind: "file",
        });

        expect(yield* fileSystem.readFileString(target)).toBe("keep\n");
        expect(
          yield* Effect.promise(() => NodeFSP.readlink(path.join(cwd, "links/linked.txt"))),
        ).toBe(target);
      }),
    );

    it.effect("moves through in-workspace symlink parents using their validated real paths", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "real-source/file.txt", "safe\n");
        yield* fileSystem.makeDirectory(path.join(cwd, "real-destination"));
        yield* fileSystem.symlink(path.join(cwd, "real-source"), path.join(cwd, "source-link"));
        yield* fileSystem.symlink(
          path.join(cwd, "real-destination"),
          path.join(cwd, "destination-link"),
        );

        yield* workspaceFileSystem.moveEntry({
          cwd,
          sourceRelativePath: "source-link/file.txt",
          destinationRelativePath: "destination-link/file.txt",
          kind: "file",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "real-destination/file.txt"))).toBe(
          "safe\n",
        );
        expect(
          yield* fileSystem.stat(path.join(cwd, "real-source/file.txt")).pipe(Effect.option),
        ).toMatchObject({ _tag: "None" });
      }),
    );
  });
});
