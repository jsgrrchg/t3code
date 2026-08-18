import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type GitHistoryCommitSummary,
  type GitListHistoryResult,
} from "@t3tools/contracts";

import {
  appendGitHistoryPage,
  createEmptyGitHistoryAccumulation,
  gitHistoryQueryOptions,
  reconcileGitHistoryTarget,
  replaceGitHistoryPage,
  type GitHistoryTarget,
} from "./git.ts";
import { environmentRpcKey } from "./runtime.ts";

const SHA = {
  first: "1111111111111111111111111111111111111111",
  second: "2222222222222222222222222222222222222222",
  third: "3333333333333333333333333333333333333333",
} as const;

function commit(sha: GitHistoryCommitSummary["sha"], subject: string): GitHistoryCommitSummary {
  return {
    sha,
    parentShas: [],
    subject,
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-08-10T00:00:00Z",
    refs: [],
  };
}

function page(
  commits: ReadonlyArray<GitHistoryCommitSummary>,
  nextCursor: number | null,
  totalCount: number | null = commits.length,
  comparison?: GitListHistoryResult["comparison"],
  branchTips?: GitListHistoryResult["branchTips"],
): GitListHistoryResult {
  return {
    commits,
    headSha: commits[0]?.sha ?? null,
    nextCursor,
    totalCount,
    ...(comparison === undefined ? {} : { comparison }),
    ...(branchTips === undefined ? {} : { branchTips }),
  };
}

const target = (
  environmentId = "environment-1",
  cwd = "/repo/one",
  projectId = "project-1",
  threadId: string | null = "thread-1",
): GitHistoryTarget => ({
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make(projectId),
  threadId: threadId === null ? null : ThreadId.make(threadId),
  cwd,
});

describe("Git history query", () => {
  it("isolates pages by environment, cwd, and cursor", () => {
    const first = {
      environmentId: EnvironmentId.make("environment-1"),
      input: {
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        cwd: "/repo/one",
        cursor: 0,
        limit: 100,
      },
    };

    expect(environmentRpcKey(first)).not.toBe(
      environmentRpcKey({ ...first, environmentId: EnvironmentId.make("environment-2") }),
    );
    expect(environmentRpcKey(first)).not.toBe(
      environmentRpcKey({ ...first, input: { ...first.input, cwd: "/repo/two" } }),
    );
    expect(environmentRpcKey(first)).not.toBe(
      environmentRpcKey({
        ...first,
        input: { ...first.input, projectId: ProjectId.make("project-2") },
      }),
    );
    expect(environmentRpcKey(first)).not.toBe(
      environmentRpcKey({ ...first, input: { ...first.input, cursor: 100 } }),
    );
  });

  it("uses finite in-memory freshness without periodic refresh", () => {
    expect(gitHistoryQueryOptions.staleTimeMs).toBeGreaterThan(0);
    expect(gitHistoryQueryOptions.idleTtlMs).toBeGreaterThan(0);
    expect("refreshIntervalMs" in gitHistoryQueryOptions).toBe(false);
  });
});

describe("Git history accumulation", () => {
  it("appends older commits in order and keeps the first duplicate", () => {
    const current = replaceGitHistoryPage(
      target(),
      page(
        [commit(SHA.first, "first"), commit(SHA.second, "second")],
        2,
        3,
        { base: "upstream/main", ahead: 1, behind: 2 },
        [commit(SHA.first, "first tip")],
      ),
    );

    const appended = appendGitHistoryPage(
      current,
      target(),
      page([commit(SHA.second, "changed duplicate"), commit(SHA.third, "third")], null, null),
    );

    expect(appended.commits.map(({ sha }) => sha)).toEqual([SHA.first, SHA.second, SHA.third]);
    expect(appended.commits[1]?.subject).toBe("second");
    expect(appended.nextCursor).toBeNull();
    expect(appended.headSha).toBe(SHA.first);
    expect(appended.totalCount).toBe(3);
    expect(appended.comparison).toEqual({ base: "upstream/main", ahead: 1, behind: 2 });
    expect(appended.branchTips?.map(({ sha }) => sha)).toEqual([SHA.first]);
  });

  it("replaces the complete generation with a refreshed first page", () => {
    const current = appendGitHistoryPage(
      replaceGitHistoryPage(target(), page([commit(SHA.first, "first")], 1)),
      target(),
      page([commit(SHA.second, "second")], null),
    );

    const refreshed = replaceGitHistoryPage(target(), page([commit(SHA.third, "new head")], null));

    expect(current.commits).toHaveLength(2);
    expect(refreshed.commits.map(({ sha }) => sha)).toEqual([SHA.third]);
    expect(refreshed.headSha).toBe(SHA.third);
  });

  it("keeps the visible generation and retry cursor when no page succeeds", () => {
    const current = replaceGitHistoryPage(target(), page([commit(SHA.first, "first")], 100));

    const afterFailure = reconcileGitHistoryTarget(current, target());
    const beforeRetry = reconcileGitHistoryTarget(afterFailure, target());

    expect(afterFailure).toBe(current);
    expect(beforeRetry.nextCursor).toBe(100);
    expect(beforeRetry.commits).toEqual(current.commits);
  });

  it("discards accumulated commits when environment, project, thread, or cwd changes", () => {
    const current = replaceGitHistoryPage(target(), page([commit(SHA.first, "first")], 100));

    const nextEnvironment = reconcileGitHistoryTarget(
      current,
      target("environment-2", "/repo/one"),
    );
    const nextCwd = reconcileGitHistoryTarget(current, target("environment-1", "/repo/two"));
    const nextProject = reconcileGitHistoryTarget(
      current,
      target("environment-1", "/repo/one", "project-2"),
    );
    const nextThread = reconcileGitHistoryTarget(
      current,
      target("environment-1", "/repo/one", "project-1", "thread-2"),
    );

    expect(nextEnvironment.commits).toEqual([]);
    expect(nextEnvironment.nextCursor).toBeNull();
    expect(nextCwd.commits).toEqual([]);
    expect(nextCwd.nextCursor).toBeNull();
    expect(nextProject.commits).toEqual([]);
    expect(nextThread.commits).toEqual([]);
  });

  it("replaces stale repository data if an append response targets another repository", () => {
    const current = replaceGitHistoryPage(target(), page([commit(SHA.first, "first")], 100));
    const nextTarget = target("environment-2", "/repo/two");

    const replaced = appendGitHistoryPage(
      current,
      nextTarget,
      page([commit(SHA.third, "other repository")], null),
    );

    expect(replaced.environmentId).toBe(nextTarget.environmentId);
    expect(replaced.cwd).toBe(nextTarget.cwd);
    expect(replaced.commits.map(({ sha }) => sha)).toEqual([SHA.third]);
  });

  it("creates an explicitly empty generation for a target", () => {
    expect(createEmptyGitHistoryAccumulation(target())).toMatchObject({
      commits: [],
      branchTips: undefined,
      headSha: null,
      nextCursor: null,
      totalCount: null,
      comparison: undefined,
    });
  });
});
