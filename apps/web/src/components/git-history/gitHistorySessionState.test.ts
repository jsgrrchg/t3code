import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type GitHistoryCommitSummary,
  type GitListHistoryResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createGitHistorySessionMemory, gitHistorySessionKey } from "./gitHistorySessionState";
import { replaceGitHistoryPage, type GitHistoryTarget } from "@t3tools/client-runtime/state/git";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function target(
  environmentId = "environment-1",
  projectId = "project-1",
  threadId = "thread-1",
  cwd = "/workspace",
): GitHistoryTarget {
  return {
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(projectId),
    threadId: ThreadId.make(threadId),
    cwd,
  };
}

function firstPage(): GitListHistoryResult {
  const commit: GitHistoryCommitSummary = {
    sha: SHA,
    parentShas: [],
    subject: "Remember history",
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-08-10T00:00:00Z",
    refs: [],
  };
  return { commits: [commit], headSha: SHA, nextCursor: 100, totalCount: 250 };
}

describe("Git history session state", () => {
  it("isolates entries by environment, project, thread, and cwd", () => {
    const base = gitHistorySessionKey(target());

    expect(gitHistorySessionKey(target("environment-2"))).not.toBe(base);
    expect(gitHistorySessionKey(target("environment-1", "project-2"))).not.toBe(base);
    expect(gitHistorySessionKey(target("environment-1", "project-1", "thread-2"))).not.toBe(base);
    expect(
      gitHistorySessionKey(target("environment-1", "project-1", "thread-1", "/other")),
    ).not.toBe(base);
  });

  it("retains loaded pages and scroll independently", () => {
    const memory = createGitHistorySessionMemory();
    const currentTarget = target();
    const key = gitHistorySessionKey(currentTarget);
    const page = firstPage();
    const history = replaceGitHistoryPage(currentTarget, page);

    memory.rememberScroll(key, 420);
    memory.rememberHistory(key, history, page);

    expect(memory.get(key)).toEqual({
      history,
      appliedFirstPage: page,
      scrollOffset: 420,
      showOnlyTips: false,
    });

    memory.rememberShowOnlyTips(key, true);
    memory.rememberScroll(key, Number.POSITIVE_INFINITY);
    expect(memory.get(key)?.history).toBe(history);
    expect(memory.get(key)?.scrollOffset).toBe(0);
    expect(memory.get(key)?.showOnlyTips).toBe(true);
  });

  it("evicts the least recently used target", () => {
    const memory = createGitHistorySessionMemory(2);
    const first = gitHistorySessionKey(target("environment-1"));
    const second = gitHistorySessionKey(target("environment-2"));
    const third = gitHistorySessionKey(target("environment-3"));

    memory.rememberScroll(first, 10);
    memory.rememberScroll(second, 20);
    expect(memory.get(first)?.scrollOffset).toBe(10);
    memory.rememberScroll(third, 30);

    expect(memory.get(second)).toBeNull();
    expect(memory.get(first)?.scrollOffset).toBe(10);
    expect(memory.get(third)?.scrollOffset).toBe(30);
    expect(memory.size).toBe(2);
  });
});
