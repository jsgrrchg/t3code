import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const WorkflowServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-workflow-test-",
});

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(WorkflowServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(WorkflowServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("lists history for Git workspaces and managed worktrees only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-history-workspace-",
      });
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-history-base-",
      });
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-history-outside-",
      });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      );
      const managedWorktree = path.join(config.worktreesDir, "repo", "feature");
      yield* fileSystem.makeDirectory(managedWorktree, { recursive: true });
      const resolveCalls: string[] = [];
      const listHistoryCalls: string[] = [];
      const gitHandle = { kind: "git" } as VcsDriverRegistry.VcsDriverHandle;
      const layer = GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: ({ cwd }) =>
              Effect.sync(() => {
                resolveCalls.push(cwd);
                return gitHandle;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            listHistory: ({ cwd }) =>
              Effect.sync(() => {
                listHistoryCalls.push(cwd);
                return { commits: [], headSha: null, nextCursor: null };
              }),
          }),
        ),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provideMerge(NodeServices.layer),
      );

      const [workspaceResult, worktreeResult] = yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const workspace = yield* workflow.listHistory({ cwd: workspaceRoot });
        const worktree = yield* workflow.listHistory({ cwd: managedWorktree });
        const outsideError = yield* workflow.listHistory({ cwd: outsideRoot }).pipe(Effect.flip);
        assert.equal(outsideError._tag, "GitCommandError");
        assert.match(outsideError.detail, /configured workspace.*managed worktrees root/);
        return [workspace, worktree] as const;
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(workspaceResult, { commits: [], headSha: null, nextCursor: null });
      assert.deepStrictEqual(worktreeResult, { commits: [], headSha: null, nextCursor: null });
      assert.deepStrictEqual(resolveCalls, [workspaceRoot, managedWorktree]);
      assert.deepStrictEqual(listHistoryCalls, [workspaceRoot, managedWorktree]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists history from sibling worktrees linked to the configured workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-history-linked-worktrees-",
      });
      const mainWorktree = path.join(parent, "main");
      const configuredWorktree = path.join(parent, "feature");
      const unrelatedDirectory = path.join(parent, "unrelated");
      const baseDir = path.join(parent, "t3-home");
      const commonGitDir = path.join(mainWorktree, ".git");
      const configuredGitDir = path.join(commonGitDir, "worktrees", "feature");
      yield* fileSystem.makeDirectory(configuredGitDir, { recursive: true });
      yield* fileSystem.makeDirectory(configuredWorktree, { recursive: true });
      yield* fileSystem.makeDirectory(unrelatedDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(configuredWorktree, ".git"),
        `gitdir: ${configuredGitDir}\n`,
      );
      yield* fileSystem.writeFileString(path.join(configuredGitDir, "commondir"), "../..\n");
      yield* fileSystem.writeFileString(
        path.join(configuredGitDir, "gitdir"),
        `${path.join(configuredWorktree, ".git")}\n`,
      );

      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(configuredWorktree, baseDir)),
      );
      const listHistoryCalls: string[] = [];
      const gitHandle = { kind: "git" } as VcsDriverRegistry.VcsDriverHandle;
      const layer = GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: () => Effect.succeed(gitHandle),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            listHistory: ({ cwd }) =>
              Effect.sync(() => {
                listHistoryCalls.push(cwd);
                return { commits: [], headSha: null, nextCursor: null };
              }),
          }),
        ),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.listHistory({ cwd: mainWorktree });

        // A .git file alone must not let an unrelated directory impersonate a
        // linked worktree; the private Git directory backlink must also match.
        yield* fileSystem.writeFileString(
          path.join(unrelatedDirectory, ".git"),
          yield* fileSystem.readFileString(path.join(configuredWorktree, ".git")),
        );
        const error = yield* workflow.listHistory({ cwd: unrelatedDirectory }).pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(listHistoryCalls, [mainWorktree]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects non-Git VCS drivers before listing history", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-history-jj-workspace-",
      });
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-history-jj-base-",
      });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      );
      const listHistory = vi.fn();
      let resolvedKind: "jj" | "unknown" = "jj";
      const layer = GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: () =>
              Effect.succeed({ kind: resolvedKind } as VcsDriverRegistry.VcsDriverHandle),
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ listHistory })),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provideMerge(NodeServices.layer),
      );

      const [jjError, unknownError] = yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const jj = yield* workflow.listHistory({ cwd: workspaceRoot }).pipe(Effect.flip);
        resolvedKind = "unknown";
        const unknown = yield* workflow.listHistory({ cwd: workspaceRoot }).pipe(Effect.flip);
        return [jj, unknown] as const;
      }).pipe(Effect.provide(layer));

      for (const error of [jjError, unknownError]) {
        expect(error).toMatchObject({
          _tag: "GitCommandError",
          operation: "GitWorkflowService.listHistory",
          command: "vcs-route",
        });
      }
      expect(listHistory).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
