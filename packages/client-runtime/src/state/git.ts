import {
  WS_METHODS,
  type EnvironmentId,
  type GitHistoryCommitSummary,
  type GitListHistoryResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export const gitHistoryQueryOptions = {
  label: "environment-data:git:history",
  tag: WS_METHODS.gitListHistory,
  staleTimeMs: 5_000,
  idleTtlMs: 5 * 60_000,
} as const;

export interface GitHistoryTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly cwd: string;
}

export interface GitHistoryAccumulation extends GitHistoryTarget {
  readonly commits: ReadonlyArray<GitHistoryCommitSummary>;
  readonly headSha: GitListHistoryResult["headSha"];
  readonly nextCursor: GitListHistoryResult["nextCursor"];
  readonly totalCount: GitListHistoryResult["totalCount"];
}

function sameGitHistoryTarget(
  accumulation: GitHistoryAccumulation,
  target: GitHistoryTarget,
): boolean {
  return (
    accumulation.environmentId === target.environmentId &&
    accumulation.projectId === target.projectId &&
    accumulation.threadId === target.threadId &&
    accumulation.cwd === target.cwd
  );
}

function dedupeGitHistoryCommits(
  commits: ReadonlyArray<GitHistoryCommitSummary>,
): ReadonlyArray<GitHistoryCommitSummary> {
  const seen = new Set<string>();
  return commits.filter((commit) => {
    if (seen.has(commit.sha)) return false;
    seen.add(commit.sha);
    return true;
  });
}

export function createEmptyGitHistoryAccumulation(
  target: GitHistoryTarget,
): GitHistoryAccumulation {
  return {
    ...target,
    commits: [],
    headSha: null,
    nextCursor: null,
    totalCount: null,
  };
}

export function reconcileGitHistoryTarget(
  accumulation: GitHistoryAccumulation,
  target: GitHistoryTarget,
): GitHistoryAccumulation {
  return sameGitHistoryTarget(accumulation, target)
    ? accumulation
    : createEmptyGitHistoryAccumulation(target);
}

export function replaceGitHistoryPage(
  target: GitHistoryTarget,
  page: GitListHistoryResult,
): GitHistoryAccumulation {
  return {
    ...target,
    commits: dedupeGitHistoryCommits(page.commits),
    headSha: page.headSha,
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
  };
}

export function appendGitHistoryPage(
  accumulation: GitHistoryAccumulation,
  target: GitHistoryTarget,
  page: GitListHistoryResult,
): GitHistoryAccumulation {
  if (!sameGitHistoryTarget(accumulation, target)) {
    return replaceGitHistoryPage(target, page);
  }
  return {
    ...accumulation,
    commits: dedupeGitHistoryCommits([...accumulation.commits, ...page.commits]),
    nextCursor: page.nextCursor,
    totalCount: accumulation.totalCount ?? page.totalCount,
  };
}

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    history: createEnvironmentRpcQueryAtomFamily(runtime, gitHistoryQueryOptions),
    pullRequestResolution: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:resolve-pull-request",
      tag: WS_METHODS.gitResolvePullRequest,
    }),
    preparePullRequestThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:prepare-pull-request-thread",
      tag: WS_METHODS.gitPreparePullRequestThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
