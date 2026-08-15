import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH,
  GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH,
  GIT_HISTORY_AUTHORED_AT_MAX_LENGTH,
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_SUBJECT_MAX_LENGTH,
  GitCommandError,
  GitHistoryCommitSummary,
  GitHistoryRef,
  GitCommitDetail,
  GitObjectId,
  type GitGetCommitDiffResult,
  type GitHistoryRef as GitHistoryRefType,
  type GitListHistoryResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  type VcsRef,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches, normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { compactTraceAttributes } from "@t3tools/shared/observability";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { ServerConfig } from "../config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_PAGE_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_PAGE_FILE_LIMIT = 100;
const REVIEW_DIFF_MANIFEST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES = 80_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 120_000;
const GIT_HISTORY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_COMMIT_DETAIL_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);

const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_TTL = Duration.minutes(10);
const REPOSITORY_PATHS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const NON_REPOSITORY_PATHS_CACHE_TTL = Duration.seconds(1);
const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;
const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);
const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const LIST_REFS_REFRESH_FAILURE_COOLDOWN = Duration.seconds(30);
const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);
const STATUS_ORIGIN_EXISTS_CACHE_TTL = Duration.minutes(5);
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});
const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
  isRepo: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

function statusUpstreamRefreshFailureCooldown(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}

class GitRefsSnapshotCacheKey extends Data.Class<{
  gitCommonDir: string;
  epoch: number;
}> {}

class GitRefsRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  generation: number;
}> {}

interface GitRepositoryPaths {
  readonly gitCommonDir: string;
  readonly worktreeRoot: string | null;
  readonly currentBranch: string | null;
}

interface GitRefsSnapshot {
  readonly localBranches: ReadonlyArray<VcsRef>;
  readonly remoteBranches: ReadonlyArray<VcsRef>;
  readonly hasPrimaryRemote: boolean;
}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | null | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorDetail?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
}

const decodeGitHistoryCommitSummary = Schema.decodeUnknownEffect(GitHistoryCommitSummary);
const decodeGitHistoryRef = Schema.decodeUnknownEffect(GitHistoryRef);
const decodeGitCommitDetail = Schema.decodeUnknownEffect(GitCommitDetail);
const decodeGitObjectId = Schema.decodeUnknownEffect(GitObjectId);
const ReviewBranchDiffCursor = Schema.Struct({
  version: Schema.Literal(1),
  snapshotId: Schema.String.check(Schema.isNonEmpty()),
  mergeBaseSha: GitObjectId,
  headSha: GitObjectId,
  ignoreWhitespace: Schema.Boolean,
  requestedBaseRef: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type ReviewBranchDiffCursor = typeof ReviewBranchDiffCursor.Type;
const ReviewWorkingTreeDiffCursor = Schema.Struct({
  version: Schema.Literal(1),
  sourceKind: Schema.Literal("working-tree"),
  snapshotId: Schema.String.check(Schema.isNonEmpty()),
  baseTreeSha: GitObjectId,
  worktreeTreeSha: GitObjectId,
  ignoreWhitespace: Schema.Boolean,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type ReviewWorkingTreeDiffCursor = typeof ReviewWorkingTreeDiffCursor.Type;
const decodeGitHistoryTotalCount = Schema.decodeUnknownEffect(
  Schema.NumberFromString.check(Schema.isGreaterThanOrEqualTo(0)),
);

function truncateGitHistoryField(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function malformedGitHistoryOutput(cwd: string, detail: string, cause?: unknown): GitCommandError {
  return new GitCommandError({
    operation: "GitVcsDriver.listHistory",
    command: "git log",
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function gitCommitReadError(
  operation: string,
  cwd: string,
  command: string,
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command,
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseCommitNumstat(stdout: string): {
  readonly changedFileCount: number;
  readonly insertions: number;
  readonly deletions: number;
} {
  const records = stdout.split("\0");
  let changedFileCount = 0;
  let insertions = 0;
  let deletions = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const additions = record.slice(0, firstTab);
    const removals = record.slice(firstTab + 1, secondTab);
    const pathValue = record.slice(secondTab + 1);
    changedFileCount += 1;
    if (additions !== "-") insertions += Number.parseInt(additions, 10) || 0;
    if (removals !== "-") deletions += Number.parseInt(removals, 10) || 0;
    if (pathValue.length === 0) index += 2;
  }
  return { changedFileCount, insertions, deletions };
}

function parseCommitChangedPaths(stdout: string) {
  const records = stdout.split("\0");
  const files: Array<{
    readonly status: string;
    readonly oldPath: string;
    readonly newPath: string;
  }> = [];
  for (let index = 0; index < records.length; ) {
    const status = records[index++] ?? "";
    if (status.length === 0) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = records[index++] ?? "";
      const newPath = records[index++] ?? "";
      if (oldPath && newPath) files.push({ status, oldPath, newPath });
      continue;
    }
    const filePath = records[index++] ?? "";
    if (filePath) files.push({ status, oldPath: filePath, newPath: filePath });
  }
  return files;
}

function quoteSyntheticDiffPath(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

function buildWithheldFilePatch(
  file: { readonly status: string; readonly oldPath: string; readonly newPath: string },
  truncatedPatch: string,
): string {
  const lines = truncatedPatch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk > 0) {
    return `${lines.slice(0, firstHunk).join("\n")}\n`;
  }
  const oldPath = file.status === "A" ? "/dev/null" : `a/${file.oldPath}`;
  const newPath = file.status === "D" ? "/dev/null" : `b/${file.newPath}`;
  const quotedOld = quoteSyntheticDiffPath(oldPath);
  const quotedNew = quoteSyntheticDiffPath(newPath);
  return [
    `diff --git "a/${quoteSyntheticDiffPath(file.oldPath)}" "b/${quoteSyntheticDiffPath(file.newPath)}"`,
    `--- ${oldPath === "/dev/null" ? oldPath : `"${quotedOld}"`}`,
    `+++ ${newPath === "/dev/null" ? newPath : `"${quotedNew}"`}`,
    "",
  ].join("\n");
}

/** Builds a list-history error that attributes malformed ref data to `git for-each-ref`. */
function malformedGitHistoryRefsOutput(
  cwd: string,
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation: "GitVcsDriver.listHistory",
    command: "git for-each-ref",
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const parseGitHistoryLogOutput = Effect.fn("parseGitHistoryLogOutput")(function* (input: {
  readonly cwd: string;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}) {
  if (input.stdoutTruncated) {
    return yield* malformedGitHistoryOutput(
      input.cwd,
      "Git history output exceeded the configured response limit.",
    );
  }

  const fields = input.stdout.split("\0");
  const tail = fields.pop() ?? "";
  if ((tail !== "" && tail !== "\n" && tail !== "\r\n") || fields.length % 6 !== 0) {
    return yield* malformedGitHistoryOutput(
      input.cwd,
      "Git history output ended with an incomplete commit record.",
    );
  }

  const commits: GitListHistoryResult["commits"][number][] = [];
  for (let index = 0; index < fields.length; index += 6) {
    const rawSha = fields[index] ?? "";
    const sha =
      index === 0
        ? rawSha
        : rawSha.startsWith("\r\n")
          ? rawSha.slice(2)
          : rawSha.startsWith("\n")
            ? rawSha.slice(1)
            : "";
    const parentShasRaw = fields[index + 1] ?? "";
    const candidate = {
      sha,
      parentShas: parentShasRaw.length === 0 ? [] : parentShasRaw.split(" "),
      subject: truncateGitHistoryField(fields[index + 2] ?? "", GIT_HISTORY_SUBJECT_MAX_LENGTH),
      authorName: truncateGitHistoryField(
        fields[index + 3] ?? "",
        GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH,
      ),
      authorEmail: truncateGitHistoryField(
        fields[index + 4] ?? "",
        GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH,
      ),
      authoredAt: truncateGitHistoryField(
        fields[index + 5] ?? "",
        GIT_HISTORY_AUTHORED_AT_MAX_LENGTH,
      ),
    };
    const commit = yield* decodeGitHistoryCommitSummary(candidate).pipe(
      Effect.mapError((cause) =>
        malformedGitHistoryOutput(
          input.cwd,
          "Git history output contained an invalid commit record.",
          cause,
        ),
      ),
    );
    commits.push(commit);
  }

  return commits;
});

/** Parses public Git refs and resolves direct or annotated-tag targets to commit IDs. */
export const parseGitHistoryRefsOutput = Effect.fn("parseGitHistoryRefsOutput")(function* (input: {
  readonly cwd: string;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}) {
  if (input.stdoutTruncated) {
    return yield* malformedGitHistoryRefsOutput(
      input.cwd,
      "Git history ref output exceeded the configured response limit.",
    );
  }

  const fields = input.stdout.split("\0");
  const tail = fields.pop() ?? "";
  if ((tail !== "" && tail !== "\n" && tail !== "\r\n") || fields.length % 6 !== 0) {
    return yield* malformedGitHistoryRefsOutput(
      input.cwd,
      "Git history ref output ended with an incomplete record.",
    );
  }

  const refs: Array<{ readonly targetSha: string; readonly ref: GitHistoryRefType }> = [];
  for (let index = 0; index < fields.length; index += 6) {
    const rawFullRefName = fields[index] ?? "";
    const fullRefName =
      index === 0
        ? rawFullRefName
        : rawFullRefName.startsWith("\r\n")
          ? rawFullRefName.slice(2)
          : rawFullRefName.startsWith("\n")
            ? rawFullRefName.slice(1)
            : "";
    const objectSha = fields[index + 1] ?? "";
    const objectType = fields[index + 2] ?? "";
    const peeledObjectSha = fields[index + 3] ?? "";
    const peeledObjectType = fields[index + 4] ?? "";
    const symbolicTarget = fields[index + 5] ?? "";
    if (symbolicTarget.length > 0) continue;

    let kind: GitHistoryRefType["kind"];
    let label: string;
    if (fullRefName.startsWith("refs/heads/")) {
      kind = "branch";
      label = fullRefName.slice("refs/heads/".length);
    } else if (fullRefName.startsWith("refs/remotes/")) {
      kind = "remote";
      label = fullRefName.slice("refs/remotes/".length);
    } else if (fullRefName.startsWith("refs/tags/")) {
      kind = "tag";
      label = fullRefName.slice("refs/tags/".length);
    } else {
      continue;
    }

    const targetShaRaw =
      objectType === "commit"
        ? objectSha
        : kind === "tag" && peeledObjectType === "commit"
          ? peeledObjectSha
          : null;
    if (targetShaRaw === null) continue;

    const targetSha = yield* decodeGitObjectId(targetShaRaw).pipe(
      Effect.mapError((cause) =>
        malformedGitHistoryRefsOutput(
          input.cwd,
          "Git history ref output contained an invalid target object ID.",
          cause,
        ),
      ),
    );
    const ref = yield* decodeGitHistoryRef({ kind, label }).pipe(
      Effect.mapError((cause) =>
        malformedGitHistoryRefsOutput(
          input.cwd,
          "Git history ref output contained an invalid ref.",
          cause,
        ),
      ),
    );
    refs.push({ targetSha, ref });
  }

  return refs;
});

function indexGitHistoryRefs(
  refs: ReadonlyArray<{ readonly targetSha: string; readonly ref: GitHistoryRefType }>,
): ReadonlyMap<string, ReadonlyArray<GitHistoryRefType>> {
  const refsBySha = new Map<string, GitHistoryRefType[]>();
  for (const { targetSha, ref } of refs) {
    const commitRefs = refsBySha.get(targetSha);
    if (commitRefs) {
      commitRefs.push(ref);
    } else {
      refsBySha.set(targetSha, [ref]);
    }
  }

  const kindOrder = { branch: 0, tag: 1, remote: 2 } satisfies Record<
    GitHistoryRefType["kind"],
    number
  >;
  for (const [sha, commitRefs] of refsBySha) {
    refsBySha.set(
      sha,
      commitRefs.toSorted(
        (left, right) =>
          kindOrder[left.kind] - kindOrder[right.kind] || left.label.localeCompare(right.label),
      ),
    );
  }
  return refsBySha;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

export function parseGitNumstat(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    const rawPath = inlinePath.length > 0 ? inlinePath : (records[index + 2] ?? "");
    if (inlinePath.length === 0) index += 2;
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    entries.push({
      path: rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

type WorkingTreeStatus = NonNullable<
  GitVcsDriver.GitStatusDetails["workingTree"]["files"][number]["status"]
>;

interface ParsedPorcelainStatus {
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly refName: string | null;
  readonly statusByPath: ReadonlyMap<string, WorkingTreeStatus>;
  readonly upstreamRef: string | null;
}

function statusFromPorcelainCode(recordKind: string, xy: string): WorkingTreeStatus {
  if (recordKind === "?") return "untracked";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("A") || xy.includes("C")) return "added";
  return "modified";
}

function pathAfterFields(record: string, fieldCount: number): string | null {
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(" ", cursor);
    if (separator < 0) return null;
    cursor = separator + 1;
  }
  const path = record.slice(cursor);
  return path.length > 0 ? path : null;
}

export function parseGitStatusPorcelainV2(stdout: string): ParsedPorcelainStatus {
  let refName: string | null = null;
  let upstreamRef: string | null = null;
  let aheadCount = 0;
  let behindCount = 0;
  const statusByPath = new Map<string, WorkingTreeStatus>();
  const records = stdout.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      refName = value.startsWith("(") ? null : value || null;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstreamRef = record.slice("# branch.upstream ".length) || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const parsed = parseBranchAb(record.slice("# branch.ab ".length));
      aheadCount = parsed.ahead;
      behindCount = parsed.behind;
      continue;
    }

    const recordKind = record[0] ?? "";
    if (recordKind === "?") {
      const path = record.slice(2);
      if (path.length > 0) statusByPath.set(path, "untracked");
      continue;
    }
    if (recordKind !== "1" && recordKind !== "2" && recordKind !== "u") continue;

    const xy = record.slice(2, 4);
    const fieldCount = recordKind === "1" ? 8 : recordKind === "2" ? 9 : 10;
    const path = pathAfterFields(record, fieldCount);
    if (path) statusByPath.set(path, statusFromPorcelainCode(recordKind, xy));
    if (recordKind === "2") index += 1;
  }

  return { aheadCount, behindCount, refName, statusByPath, upstreamRef };
}

function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
    nextCursor,
    totalCount,
  };
}

function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null && currentBranch !== null && !currentPrunable) {
      worktreePaths.set(currentBranch, currentPath);
    }
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return worktreePaths;
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
  return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated);
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function gitCommandContext(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
) {
  return {
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
  } as const;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  if (!(error.cause instanceof PlatformError.PlatformError)) {
    return false;
  }

  const reason = error.cause.reason;
  if (reason._tag === "NotFound") {
    return reason.pathOrDescriptor === error.cwd;
  }

  return (
    reason._tag === "BadResource" &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENOTDIR"
  );
}

function isNonRepositoryGitStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}
function isUnbornHeadStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("bad revision 'head'") ||
    (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
  );
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.void,
    }),
  );

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitVcsDriver.trace2: failed to parse trace line for ${input.operation} in ${input.cwd} (${input.args.length} arguments)`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: DateTime.toEpochMillis(now) });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const collectOutput = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        ...gitCommandContext(input),
        detail: `Git output exceeded ${maxOutputBytes} bytes and was truncated.`,
        outputLength: nextBytes,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new GitCommandError({
          ...gitCommandContext(input),
          detail: "Failed to read Git process output.",
          cause,
        }),
    }),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { worktreesDir } = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to create Git trace monitor.",
                cause,
              }),
          ),
        );
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make("git", commandInput.args, {
              cwd: commandInput.cwd,
              env: {
                ...process.env,
                ...input.env,
                ...trace2Monitor.env,
              },
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to spawn Git process.",
                  cause,
                }),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStdoutLine,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStderrLine,
            ),
            child.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Failed to read Git process exit code.",
                    cause,
                  }),
              ),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        ...gitCommandContext(commandInput),
                        detail: "Failed to write Git process input.",
                        cause,
                      }),
                  ),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          return yield* new GitCommandError({
            ...gitCommandContext(commandInput),
            detail: "Git command exited with a non-zero status.",
            exitCode,
            stdoutLength: stdout.text.length,
            stderrLength: stderr.text.length,
          });
        }

        return {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies GitVcsDriver.ExecuteGitResult;
      });

      const execution = runGitCommand().pipe(Effect.scoped);
      if (timeoutMs === null) {
        return yield* execution;
      }

      return yield* execution.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Git command timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    },
  );

  const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
    executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
          return Effect.succeed(result);
        }
        return Effect.fail(
          new GitCommandError({
            ...gitCommandContext({ operation, cwd, args }),
            detail: options.fallbackErrorDetail ?? "Git command exited with a non-zero status.",
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
        );
      }),
    );

  const executeGitWithStableDiagnostics = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    executeGit(operation, cwd, args, {
      ...options,
      env: {
        ...options.env,
        LC_ALL: "C",
      },
    });

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.renameBranch",
        cwd,
        args: ["branch", "-m", "--", desiredBranch],
      }),
      detail: `Could not find an available branch name for '${desiredBranch}'.`,
    });
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = (
    gitCommonDir: string,
    remoteName: string,
  ): Effect.Effect<void, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return executeGit(
      "GitVcsDriver.fetchRemoteForStatus",
      fetchCwd,
      ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
      {
        env: STATUS_UPSTREAM_REFRESH_ENV,
        fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const resolveRepositoryPathsUncached = Effect.fn("resolveRepositoryPathsUncached")(function* (
    cwd: string,
  ) {
    const commonDirResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.resolveRepositoryPaths.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    );
    if (commonDirResult.exitCode !== 0) {
      const stderr = commonDirResult.stderr.trim();
      if (isNonRepositoryGitStderr(stderr)) {
        return null;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.resolveRepositoryPaths.commonDir",
          cwd,
          args: ["rev-parse", "--git-common-dir"],
        }),
        detail: "Failed to resolve the Git common directory.",
        exitCode: commonDirResult.exitCode,
        stdoutLength: commonDirResult.stdout.length,
        stderrLength: commonDirResult.stderr.length,
      });
    }

    const commonDirOutput = commonDirResult.stdout.trim();
    const resolvedGitCommonDir = path.isAbsolute(commonDirOutput)
      ? path.normalize(commonDirOutput)
      : path.resolve(cwd, commonDirOutput);
    const gitCommonDir = yield* fileSystem
      .realPath(resolvedGitCommonDir)
      .pipe(Effect.orElseSucceed(() => resolvedGitCommonDir));
    const [worktreeRootResult, currentBranchResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.worktreeRoot",
          cwd,
          ["rev-parse", "--show-toplevel"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.currentBranch",
          cwd,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
      ],
      { concurrency: 2 },
    );
    const worktreeRootOutput = worktreeRootResult.stdout.trim();
    const worktreeRoot =
      worktreeRootResult.exitCode === 0 && worktreeRootOutput.length > 0
        ? path.normalize(
            path.isAbsolute(worktreeRootOutput)
              ? worktreeRootOutput
              : path.resolve(cwd, worktreeRootOutput),
          )
        : null;
    const currentBranchOutput = currentBranchResult.stdout.trim();
    const currentBranch =
      currentBranchResult.exitCode === 0 && currentBranchOutput.length > 0
        ? currentBranchOutput
        : null;

    return {
      gitCommonDir,
      worktreeRoot,
      currentBranch,
    } satisfies GitRepositoryPaths;
  });

  const repositoryPathsCache = yield* Cache.makeWith(
    (cwd: string) => resolveRepositoryPathsUncached(cwd),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const repositoryPathsRefreshCache = yield* Cache.makeWith(
    (cwd: string) =>
      Cache.invalidate(repositoryPathsCache, cwd).pipe(
        Effect.andThen(Cache.get(repositoryPathsCache, cwd)),
      ),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null
            ? NON_REPOSITORY_PATHS_CACHE_TTL
            : REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const normalizeRepositoryPathsCacheKey = (cwd: string) => path.normalize(path.resolve(cwd));
  const resolveRepositoryPaths = (cwd: string, refresh = false) => {
    const cacheKey = normalizeRepositoryPathsCacheKey(cwd);
    return Cache.get(refresh ? repositoryPathsRefreshCache : repositoryPathsCache, cacheKey);
  };

  const defaultBranchCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.defaultBranch",
          fetchCwd,
          ["--git-dir", gitCommonDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => {
            if (result.exitCode !== 0) return null;
            return parseDefaultBranchFromRemoteHeadRef(result.stdout, "origin");
          }),
        );
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_DEFAULT_BRANCH_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const originExistsCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.originExists",
          fetchCwd,
          ["--git-dir", gitCommonDir, "remote", "get-url", "origin"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.exitCode === 0));
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_ORIGIN_EXISTS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const invalidateStatusStaticCaches = (cwd: string) =>
    Effect.gen(function* () {
      const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
        Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
      );
      const cacheKey = repositoryPaths?.gitCommonDir ?? normalizeRepositoryPathsCacheKey(cwd);
      yield* Cache.invalidate(defaultBranchCache, cacheKey);
      yield* Cache.invalidate(originExistsCache, cacheKey);
    });

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const repositoryPaths = yield* resolveRepositoryPaths(cwd);
    if (repositoryPaths !== null) {
      return repositoryPaths.gitCommonDir;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      }),
      detail: "Cannot resolve a Git common directory outside a repository.",
    });
  });

  const statusRemoteRefreshFailureCounts = new Map<string, number>();
  const statusRemoteRefreshFailureKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
    `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;
  const recordStatusRemoteRefreshFailure = (cacheKey: StatusRemoteRefreshCacheKey) => {
    const key = statusRemoteRefreshFailureKey(cacheKey);
    const nextCount = (statusRemoteRefreshFailureCounts.get(key) ?? 0) + 1;
    statusRemoteRefreshFailureCounts.delete(key);
    statusRemoteRefreshFailureCounts.set(key, nextCount);
    if (statusRemoteRefreshFailureCounts.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
      const oldestKey = statusRemoteRefreshFailureCounts.keys().next().value;
      if (oldestKey !== undefined) {
        statusRemoteRefreshFailureCounts.delete(oldestKey);
      }
    }
  };
  const clearStatusRemoteRefreshFailures = (cacheKey: StatusRemoteRefreshCacheKey) => {
    statusRemoteRefreshFailureCounts.delete(statusRemoteRefreshFailureKey(cacheKey));
  };
  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    return yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
      Effect.tap(() => Effect.sync(() => clearStatusRemoteRefreshFailures(cacheKey))),
      Effect.tapError(() => Effect.sync(() => recordStatusRemoteRefreshFailure(cacheKey))),
      Effect.as(true as const),
    );
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // A failed background fetch is intentionally cached and exponentially
    // backed off. Status reads swallow this failure and use the last fetched
    // refs, so repeated thread mounts cannot turn a slow or unavailable remote
    // into a repository-wide Git subprocess storm.
    timeToLive: (exit, cacheKey) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : statusUpstreamRefreshFailureCooldown(
            statusRemoteRefreshFailureCounts.get(statusRemoteRefreshFailureKey(cacheKey)) ?? 1,
          ),
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({
        gitCommonDir,
        remoteName: upstream.remoteName,
      }),
    );
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    refName: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const remoteExists: GitVcsDriver.GitVcsDriver["Service"]["remoteExists"] = (input) =>
    executeGit("GitVcsDriver.remoteExists", input.cwd, ["remote", "get-url", input.remoteName], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    remoteExists({ cwd, remoteName: "origin" });

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolvePrimaryRemoteName",
        cwd,
        args: ["remote"],
      }),
      detail: "No git remote is configured for this repository.",
    });
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
    "ensureRemote",
  )(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeGitRemoteUrl(input.url);
    const remoteFetchUrls = yield* runGitStdout(
      "GitVcsDriver.ensureRemote.listRemoteUrls",
      input.cwd,
      ["remote", "-v"],
    ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

    for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
      if (normalizeGitRemoteUrl(remoteUrl) === normalizedTargetUrl) {
        return remoteName;
      }
    }

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
      "remote",
      "add",
      remoteName,
      input.url,
    ]);
    return remoteName;
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${refName}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === refName) {
        continue;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    refName: string,
  ) {
    const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName);
    if (!baseRef) {
      return 0;
    }

    const result = yield* executeGit(
      "GitVcsDriver.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
    const branchResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetailsRemote.branch",
      cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (branchResult === null) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    let branch: string | null;
    if (branchResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(branchResult.stderr)) {
        return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
      }
      if (!isUnbornHeadStderr(branchResult.stderr)) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.statusDetailsRemote.branch",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
          }),
          detail: "Git branch lookup failed.",
          exitCode: branchResult.exitCode,
          stdoutLength: branchResult.stdout.length,
          stderrLength: branchResult.stderr.length,
        });
      }

      const branchValue = yield* runGitStdout(
        "GitVcsDriver.statusDetailsRemote.unbornBranch",
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
      );
      branch = branchValue.trim() || null;
    } else {
      const branchValue = branchResult.stdout.trim();
      branch = branchValue.length > 0 && branchValue !== "HEAD" ? branchValue : null;
    }
    const upstream = yield* resolveCurrentUpstream(cwd);
    const upstreamRef = upstream?.upstreamRef ?? null;
    let aheadCount = 0;
    let behindCount = 0;

    if (upstreamRef) {
      const divergence = yield* executeGit(
        "GitVcsDriver.statusDetailsRemote.divergence",
        cwd,
        ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
        { allowNonZeroExit: true },
      );
      if (divergence.exitCode === 0) {
        const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
        const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
        const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
        aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
        behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
      }
    } else if (branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.orElseSucceed(() => 0),
      );
    }

    const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? upstreamRef === null
          ? aheadCount
          : yield* computeAheadCountAgainstBase(cwd, branch).pipe(Effect.orElseSucceed(() => 0))
        : 0;

    return {
      isRepo: true,
      isDefaultBranch,
      branch,
      upstreamRef,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    const statusResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch", "-z"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(statusResult.stderr)) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetails.status",
          cwd,
          args: ["status", "--porcelain=2", "--branch", "-z"],
        }),
        detail: "Git status failed.",
        exitCode: statusResult.exitCode,
        stdoutLength: statusResult.stdout.length,
        stderrLength: statusResult.stderr.length,
      });
    }

    const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
      Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
    );
    const statusCacheKey = repositoryPaths?.gitCommonDir;
    const [numstatEntries, defaultBranch, hasPrimaryRemote] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.statusDetails.numstat",
          cwd,
          ["diff", "HEAD", "--numstat", "--"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(parseGitNumstat(result.stdout));
            if (isUnbornHeadStderr(result.stderr)) {
              return Effect.map(
                Effect.all([
                  runGitStdout("GitVcsDriver.statusDetails.numstat.unborn", cwd, [
                    "diff",
                    "--numstat",
                    "-z",
                  ]),
                  runGitStdout("GitVcsDriver.statusDetails.numstat.unborn.staged", cwd, [
                    "diff",
                    "--cached",
                    "--numstat",
                    "-z",
                  ]),
                ]),
                ([unstagedStdout, stagedStdout]) => {
                  const staged = parseGitNumstat(stagedStdout);
                  const unstaged = parseGitNumstat(unstagedStdout);
                  const map = new Map<string, { insertions: number; deletions: number }>();
                  for (const entry of [...staged, ...unstaged]) {
                    const existing = map.get(entry.path) ?? {
                      insertions: 0,
                      deletions: 0,
                    };
                    existing.insertions += entry.insertions;
                    existing.deletions += entry.deletions;
                    map.set(entry.path, existing);
                  }
                  return Array.from(map.entries()).map(([path, stats]) => ({ path, ...stats }));
                },
              );
            }
            return Effect.fail(
              new GitCommandError({
                ...gitCommandContext({
                  operation: "GitVcsDriver.statusDetails.numstat",
                  cwd,
                  args: ["diff", "HEAD", "--numstat", "--"],
                }),
                detail: "git diff HEAD --numstat failed.",
                exitCode: result.exitCode,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
            );
          }),
        ),
        statusCacheKey
          ? Cache.get(defaultBranchCache, statusCacheKey).pipe(Effect.orElseSucceed(() => null))
          : resolveDefaultBranchName(cwd, "origin").pipe(Effect.orElseSucceed(() => null)),
        statusCacheKey
          ? Cache.get(originExistsCache, statusCacheKey).pipe(Effect.orElseSucceed(() => false))
          : originRemoteExists(cwd).pipe(Effect.orElseSucceed(() => false)),
      ],
      { concurrency: "unbounded" },
    );
    const parsedStatus = parseGitStatusPorcelainV2(statusResult.stdout);
    const { refName, statusByPath, upstreamRef } = parsedStatus;
    let aheadCount = parsedStatus.aheadCount;
    let behindCount = parsedStatus.behindCount;
    let aheadOfDefaultCount = 0;
    const hasWorkingTreeChanges = statusByPath.size > 0;

    const fallbackAheadCount =
      !upstreamRef && refName
        ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0))
        : null;

    if (fallbackAheadCount !== null) {
      aheadCount = fallbackAheadCount;
      behindCount = 0;
    }

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));
    if (refName && !isDefaultBranch) {
      aheadOfDefaultCount =
        fallbackAheadCount !== null
          ? fallbackAheadCount
          : yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0));
    }

    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of numstatEntries) {
      fileStatMap.set(entry.path, { insertions: entry.insertions, deletions: entry.deletions });
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return {
          path: filePath,
          status: statusByPath.get(filePath) ?? "modified",
          insertions: stat.insertions,
          deletions: stat.deletions,
        };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const [filePath, status] of statusByPath) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, status, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote: hasPrimaryRemote,
      isDefaultBranch,
      branch: refName,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
    "statusDetails",
  )(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
      }),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
    Effect.fn("statusDetailsRemote")(function* (cwd, options) {
      if (options?.refreshUpstream !== false) {
        yield* refreshStatusUpstreamIfStale(cwd).pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
          }),
          Effect.ignoreCause({ log: true }),
        );
      }
      return yield* readStatusDetailsRemote(cwd);
    });

  const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  const prepareCommitContext: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] =
    Effect.fn("prepareCommitContext")(function* (cwd, filePaths) {
      if (filePaths && filePaths.length > 0) {
        yield* runGit("GitVcsDriver.prepareCommitContext.reset", cwd, ["reset"]).pipe(
          Effect.catchTags({
            GitCommandError: () => Effect.void,
          }),
        );
        yield* runGit("GitVcsDriver.prepareCommitContext.addSelected", cwd, [
          "--literal-pathspecs",
          "add",
          "-A",
          "--",
          ...filePaths,
        ]);
      } else {
        yield* runGit("GitVcsDriver.prepareCommitContext.addAll", cwd, ["add", "-A"]);
      }

      const stagedSummary = yield* runGitStdout(
        "GitVcsDriver.prepareCommitContext.stagedSummary",
        cwd,
        ["diff", "--cached", "--name-status"],
      ).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runGitStdoutWithOptions(
        "GitVcsDriver.prepareCommitContext.stagedPatch",
        cwd,
        ["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"],
        {
          maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
  ) {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pushCurrentBranch",
          cwd,
          args: ["push"],
        }),
        detail: "Cannot push from detached HEAD.",
      });
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
        cwd,
        ["push", "-u", requestedRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
    if (hasNoLocalDelta) {
      if (details.hasUpstream) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (hasRemoteBranch) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }
      }
    }

    if (!details.hasUpstream) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
      if (!publishRemoteName) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pushCurrentBranch",
            cwd,
            args: ["push"],
          }),
          detail: "Cannot push because no git remote is configured for this repository.",
        });
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithUpstream",
        cwd,
        ["push", "-u", publishRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (currentUpstream) {
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushUpstream",
        cwd,
        ["push", currentUpstream.remoteName, `HEAD:refs/heads/${currentUpstream.branchName}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"], { timeoutMs: null });
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd) {
    const details = yield* statusDetails(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Cannot pull from detached HEAD.",
      });
    }
    if (!details.hasUpstream) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Current branch has no upstream configured. Push with upstream first.",
      });
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
      timeoutMs: 30_000,
      fallbackErrorDetail: "git pull failed",
    });
    const afterSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const refreshed = yield* statusDetails(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      refName,
      upstreamRef: refreshed.upstreamRef,
    };
  });

  const readRangeContext: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef) {
    const range = `${baseRef}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", range],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", range],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--no-ext-diff", "--patch", "--minimal", range],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  });

  const readUntrackedReviewDiffs = Effect.fn("readUntrackedReviewDiffs")(function* (cwd: string) {
    const untrackedResult = yield* executeGit(
      "GitVcsDriver.readUntrackedReviewDiffs.list",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    const untrackedPaths = splitNullSeparatedGitStdoutPaths(untrackedResult);
    if (untrackedPaths.length === 0) {
      return { diff: "", truncated: untrackedResult.stdoutTruncated };
    }

    const diffs = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        executeGit(
          "GitVcsDriver.readUntrackedReviewDiffs.diff",
          cwd,
          [
            "diff",
            "--no-index",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            "--",
            "/dev/null",
            relativePath,
          ],
          {
            allowNonZeroExit: true,
            maxOutputBytes: REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      { concurrency: 4 },
    );

    return {
      diff: Arr.filterMap(diffs, (result) =>
        result.stdout.trim().length > 0 ? Result.succeed(result.stdout) : Result.failVoid,
      ).join("\n"),
      truncated: untrackedResult.stdoutTruncated || diffs.some((result) => result.stdoutTruncated),
    };
  });

  const reviewDiffPageError = (cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: "GitVcsDriver.getReviewDiffPreview.page",
      command: "git diff",
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const hashReviewDiffValue = Effect.fn("hashReviewDiffValue")(function* (
    cwd: string,
    value: string,
  ) {
    return yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError((cause) =>
        reviewDiffPageError(cwd, "Failed to hash paged review diff data.", cause),
      ),
    );
  });

  const snapshotIdForReviewBranch = (
    cwd: string,
    mergeBaseSha: string,
    headSha: string,
    ignoreWhitespace: boolean,
  ) => hashReviewDiffValue(cwd, `${mergeBaseSha}\0${headSha}\0${ignoreWhitespace ? "1" : "0"}`);

  const snapshotIdForReviewWorkingTree = (
    cwd: string,
    baseTreeSha: string,
    worktreeTreeSha: string,
    ignoreWhitespace: boolean,
  ) =>
    hashReviewDiffValue(
      cwd,
      `working-tree\0${baseTreeSha}\0${worktreeTreeSha}\0${ignoreWhitespace ? "1" : "0"}`,
    );

  const encodeReviewBranchCursor = (cursor: ReviewBranchDiffCursor): string =>
    Encoding.encodeBase64Url(JSON.stringify(cursor));

  const encodeReviewWorkingTreeCursor = (cursor: ReviewWorkingTreeDiffCursor): string =>
    Encoding.encodeBase64Url(JSON.stringify(cursor));

  const decodeReviewBranchCursor = Effect.fn("decodeReviewBranchCursor")(function* (
    input: ReviewDiffPreviewInput,
    encoded: string,
  ) {
    const decodedText = Encoding.decodeBase64UrlString(encoded);
    if (Result.isFailure(decodedText)) {
      return yield* reviewDiffPageError(input.cwd, "Review diff cursor is not valid base64url.");
    }
    const decoded = decodeJsonResult(ReviewBranchDiffCursor)(decodedText.success);
    if (Result.isFailure(decoded)) {
      return yield* reviewDiffPageError(
        input.cwd,
        "Review diff cursor has an invalid shape.",
        decoded.failure,
      );
    }
    const cursor = decoded.success;
    if (
      cursor.ignoreWhitespace !== (input.ignoreWhitespace ?? false) ||
      cursor.requestedBaseRef !== (input.baseRef ?? null)
    ) {
      return yield* reviewDiffPageError(
        input.cwd,
        "Review diff cursor belongs to a different comparison scope.",
      );
    }
    const expectedSnapshotId = yield* snapshotIdForReviewBranch(
      input.cwd,
      cursor.mergeBaseSha,
      cursor.headSha,
      cursor.ignoreWhitespace,
    );
    if (expectedSnapshotId !== cursor.snapshotId) {
      return yield* reviewDiffPageError(input.cwd, "Review diff cursor snapshot is invalid.");
    }
    return cursor;
  });

  const resolveReviewBranchCursor = Effect.fn("resolveReviewBranchCursor")(function* (
    input: ReviewDiffPreviewInput,
    baseRef: string | null,
  ) {
    const encodedCursor = input.pagination?.cursor;
    if (encodedCursor !== undefined) {
      return yield* decodeReviewBranchCursor(input, encodedCursor);
    }
    if (baseRef === null) {
      return yield* reviewDiffPageError(input.cwd, "Review diff has no base ref to paginate.");
    }

    const headResult = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.page.head",
      input.cwd,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      {
        maxOutputBytes: 256,
        fallbackErrorDetail: "Failed to resolve the review diff head commit.",
      },
    );
    const headSha = yield* decodeGitObjectId(headResult.stdout.trim()).pipe(
      Effect.mapError((cause) =>
        reviewDiffPageError(input.cwd, "Git returned an invalid review head object ID.", cause),
      ),
    );
    const mergeBaseResult = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.page.mergeBase",
      input.cwd,
      ["merge-base", baseRef, headSha],
      {
        maxOutputBytes: 256,
        fallbackErrorDetail: "Failed to resolve the review diff merge base.",
      },
    );
    const mergeBaseSha = yield* decodeGitObjectId(mergeBaseResult.stdout.trim()).pipe(
      Effect.mapError((cause) =>
        reviewDiffPageError(input.cwd, "Git returned an invalid merge-base object ID.", cause),
      ),
    );
    const ignoreWhitespace = input.ignoreWhitespace ?? false;
    return {
      version: 1 as const,
      snapshotId: yield* snapshotIdForReviewBranch(
        input.cwd,
        mergeBaseSha,
        headSha,
        ignoreWhitespace,
      ),
      mergeBaseSha,
      headSha,
      ignoreWhitespace,
      requestedBaseRef: input.baseRef ?? null,
      offset: 0,
    } satisfies ReviewBranchDiffCursor;
  });

  const decodeReviewWorkingTreeCursor = Effect.fn("decodeReviewWorkingTreeCursor")(function* (
    input: ReviewDiffPreviewInput,
    encoded: string,
  ) {
    const decodedText = Encoding.decodeBase64UrlString(encoded);
    if (Result.isFailure(decodedText)) {
      return yield* reviewDiffPageError(input.cwd, "Review diff cursor is not valid base64url.");
    }
    const decoded = decodeJsonResult(ReviewWorkingTreeDiffCursor)(decodedText.success);
    if (Result.isFailure(decoded)) {
      return yield* reviewDiffPageError(
        input.cwd,
        "Review diff cursor has an invalid shape.",
        decoded.failure,
      );
    }
    const cursor = decoded.success;
    if (cursor.ignoreWhitespace !== (input.ignoreWhitespace ?? false)) {
      return yield* reviewDiffPageError(
        input.cwd,
        "Review diff cursor belongs to a different comparison scope.",
      );
    }
    const expectedSnapshotId = yield* snapshotIdForReviewWorkingTree(
      input.cwd,
      cursor.baseTreeSha,
      cursor.worktreeTreeSha,
      cursor.ignoreWhitespace,
    );
    if (expectedSnapshotId !== cursor.snapshotId) {
      return yield* reviewDiffPageError(input.cwd, "Review diff cursor snapshot is invalid.");
    }
    return cursor;
  });

  const resolveReviewWorkingTreeCursor = Effect.fn("resolveReviewWorkingTreeCursor")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const encodedCursor = input.pagination?.cursor;
    if (encodedCursor !== undefined) {
      return yield* decodeReviewWorkingTreeCursor(input, encodedCursor);
    }

    const repositoryPaths = yield* resolveRepositoryPaths(input.cwd);
    if (repositoryPaths?.worktreeRoot === null || repositoryPaths === null) {
      return yield* reviewDiffPageError(input.cwd, "Review diff has no working tree to paginate.");
    }
    const worktreeRoot = repositoryPaths.worktreeRoot;
    const headResult = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.workingTreeSnapshot.head",
      worktreeRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { allowNonZeroExit: true, maxOutputBytes: 256 },
    );
    const baseTreeSha =
      headResult.exitCode === 0
        ? yield* decodeGitObjectId(headResult.stdout.trim()).pipe(
            Effect.mapError((cause) =>
              reviewDiffPageError(
                input.cwd,
                "Git returned an invalid working-tree base object ID.",
                cause,
              ),
            ),
          )
        : yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.workingTreeSnapshot.emptyTree",
            worktreeRoot,
            ["hash-object", "-t", "tree", "--stdin"],
            { stdin: "", maxOutputBytes: 256 },
          ).pipe(
            Effect.flatMap((result) => decodeGitObjectId(result.stdout.trim())),
            Effect.mapError((cause) =>
              reviewDiffPageError(
                input.cwd,
                "Failed to resolve the empty Git tree for an unborn working tree.",
                cause,
              ),
            ),
          );
    const worktreeTreeSha = yield* Effect.acquireUseRelease(
      fileSystem
        .makeTempDirectory({ prefix: "t3code-review-index-" })
        .pipe(
          Effect.mapError((cause) =>
            reviewDiffPageError(input.cwd, "Failed to create a temporary review index.", cause),
          ),
        ),
      (tempDirectory) => {
        const indexPath = path.join(tempDirectory, "index");
        const env = { GIT_INDEX_FILE: indexPath };
        return Effect.gen(function* () {
          yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.workingTreeSnapshot.readTree",
            worktreeRoot,
            ["read-tree", baseTreeSha],
            { env, fallbackErrorDetail: "Failed to initialize the temporary review index." },
          );
          yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.workingTreeSnapshot.add",
            worktreeRoot,
            ["add", "-A", "--", "."],
            { env, fallbackErrorDetail: "Failed to snapshot the working tree." },
          );
          const treeResult = yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.workingTreeSnapshot.writeTree",
            worktreeRoot,
            ["write-tree"],
            {
              env,
              maxOutputBytes: 256,
              fallbackErrorDetail: "Failed to write the working-tree snapshot.",
            },
          );
          return yield* decodeGitObjectId(treeResult.stdout.trim()).pipe(
            Effect.mapError((cause) =>
              reviewDiffPageError(
                input.cwd,
                "Git returned an invalid working-tree snapshot object ID.",
                cause,
              ),
            ),
          );
        });
      },
      (tempDirectory) =>
        fileSystem.remove(tempDirectory, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
    );
    const ignoreWhitespace = input.ignoreWhitespace ?? false;
    return {
      version: 1 as const,
      sourceKind: "working-tree" as const,
      snapshotId: yield* snapshotIdForReviewWorkingTree(
        input.cwd,
        baseTreeSha,
        worktreeTreeSha,
        ignoreWhitespace,
      ),
      baseTreeSha,
      worktreeTreeSha,
      ignoreWhitespace,
      offset: 0,
    } satisfies ReviewWorkingTreeDiffCursor;
  });

  const readReviewDiffPagePatch = Effect.fn("readReviewDiffPagePatch")(function* (
    input: ReviewDiffPreviewInput,
    comparison: {
      readonly baseSha: string;
      readonly headSha: string;
      readonly ignoreWhitespace: boolean;
    },
    files: ReturnType<typeof parseCommitChangedPaths>,
  ): Effect.fn.Return<
    { readonly patch: string; readonly consumed: number; readonly truncated: boolean },
    GitCommandError
  > {
    const paths = [
      ...new Set(files.flatMap((file) => [file.oldPath, file.newPath]).filter(Boolean)),
    ];
    const result = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.page.patch",
      input.cwd,
      [
        "diff",
        "--patch",
        "-M",
        "-C",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...(comparison.ignoreWhitespace ? ["--ignore-all-space"] : []),
        comparison.baseSha,
        comparison.headSha,
        "--",
        ...paths,
      ],
      {
        maxOutputBytes: REVIEW_DIFF_PAGE_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
        fallbackErrorDetail: "Failed to read a review diff page.",
      },
    );
    if (!result.stdoutTruncated) {
      return { patch: result.stdout, consumed: files.length, truncated: false };
    }
    if (files.length === 1) {
      return {
        patch: buildWithheldFilePatch(files[0]!, result.stdout),
        consumed: 1,
        truncated: true,
      };
    }
    return yield* readReviewDiffPagePatch(
      input,
      comparison,
      files.slice(0, Math.ceil(files.length / 2)),
    );
  });

  const getPagedReviewBranchDiff = Effect.fn("getPagedReviewBranchDiff")(function* (
    input: ReviewDiffPreviewInput,
    baseRef: string | null,
  ) {
    const cursor = yield* resolveReviewBranchCursor(input, baseRef);
    const diffOptions = [
      "diff",
      "-M",
      "-C",
      ...(cursor.ignoreWhitespace ? ["--ignore-all-space"] : []),
    ];
    const [manifestResult, numstatResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.getReviewDiffPreview.page.manifest",
          input.cwd,
          [...diffOptions, "--name-status", "-z", cursor.mergeBaseSha, cursor.headSha, "--"],
          {
            maxOutputBytes: REVIEW_DIFF_MANIFEST_MAX_OUTPUT_BYTES,
            fallbackErrorDetail: "Review diff manifest exceeded the configured limit.",
          },
        ),
        executeGit(
          "GitVcsDriver.getReviewDiffPreview.page.numstat",
          input.cwd,
          [...diffOptions, "--numstat", "-z", cursor.mergeBaseSha, cursor.headSha, "--"],
          {
            maxOutputBytes: REVIEW_DIFF_MANIFEST_MAX_OUTPUT_BYTES,
            fallbackErrorDetail: "Review diff statistics exceeded the configured limit.",
          },
        ),
      ],
      { concurrency: 2 },
    );
    const manifest = parseCommitChangedPaths(manifestResult.stdout);
    if (cursor.offset > manifest.length) {
      return yield* reviewDiffPageError(input.cwd, "Review diff cursor is past the manifest end.");
    }
    const candidates = manifest.slice(cursor.offset, cursor.offset + REVIEW_DIFF_PAGE_FILE_LIMIT);
    const page =
      candidates.length === 0
        ? { patch: "", consumed: 0, truncated: false }
        : yield* readReviewDiffPagePatch(
            input,
            {
              baseSha: cursor.mergeBaseSha,
              headSha: cursor.headSha,
              ignoreWhitespace: cursor.ignoreWhitespace,
            },
            candidates,
          );
    const nextOffset = cursor.offset + page.consumed;
    const nextCursor =
      nextOffset < manifest.length
        ? encodeReviewBranchCursor({ ...cursor, offset: nextOffset })
        : null;
    const stats = parseCommitNumstat(numstatResult.stdout);
    const diffHash = yield* hashReviewDiffValue(input.cwd, page.patch);
    const source: ReviewDiffPreviewSource = {
      id: "branch-range",
      kind: "branch-range",
      title: input.baseRef ? `Against ${input.baseRef}` : "Against base branch",
      baseRef: cursor.mergeBaseSha,
      headRef: cursor.headSha,
      diff: page.patch,
      diffHash,
      truncated: page.truncated,
      nextCursor,
      snapshotId: cursor.snapshotId,
      stats: {
        fileCount: manifest.length,
        additions: stats.insertions,
        deletions: stats.deletions,
      },
    };
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [source],
    };
  });

  const getPagedReviewWorkingTreeDiff = Effect.fn("getPagedReviewWorkingTreeDiff")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const cursor = yield* resolveReviewWorkingTreeCursor(input);
    const diffOptions = [
      "diff",
      "-M",
      "-C",
      ...(cursor.ignoreWhitespace ? ["--ignore-all-space"] : []),
    ];
    const [manifestResult, numstatResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.getReviewDiffPreview.workingTreePage.manifest",
          input.cwd,
          [...diffOptions, "--name-status", "-z", cursor.baseTreeSha, cursor.worktreeTreeSha, "--"],
          {
            maxOutputBytes: REVIEW_DIFF_MANIFEST_MAX_OUTPUT_BYTES,
            fallbackErrorDetail: "Working-tree diff manifest exceeded the configured limit.",
          },
        ),
        executeGit(
          "GitVcsDriver.getReviewDiffPreview.workingTreePage.numstat",
          input.cwd,
          [...diffOptions, "--numstat", "-z", cursor.baseTreeSha, cursor.worktreeTreeSha, "--"],
          {
            maxOutputBytes: REVIEW_DIFF_MANIFEST_MAX_OUTPUT_BYTES,
            fallbackErrorDetail: "Working-tree diff statistics exceeded the configured limit.",
          },
        ),
      ],
      { concurrency: 2 },
    );
    const manifest = parseCommitChangedPaths(manifestResult.stdout);
    if (cursor.offset > manifest.length) {
      return yield* reviewDiffPageError(input.cwd, "Review diff cursor is past the manifest end.");
    }
    const candidates = manifest.slice(cursor.offset, cursor.offset + REVIEW_DIFF_PAGE_FILE_LIMIT);
    const page =
      candidates.length === 0
        ? { patch: "", consumed: 0, truncated: false }
        : yield* readReviewDiffPagePatch(
            input,
            {
              baseSha: cursor.baseTreeSha,
              headSha: cursor.worktreeTreeSha,
              ignoreWhitespace: cursor.ignoreWhitespace,
            },
            candidates,
          );
    const nextOffset = cursor.offset + page.consumed;
    const nextCursor =
      nextOffset < manifest.length
        ? encodeReviewWorkingTreeCursor({ ...cursor, offset: nextOffset })
        : null;
    const stats = parseCommitNumstat(numstatResult.stdout);
    const diffHash = yield* hashReviewDiffValue(input.cwd, page.patch);
    const source: ReviewDiffPreviewSource = {
      id: "working-tree",
      kind: "working-tree",
      title: "Dirty worktree",
      baseRef: cursor.baseTreeSha,
      headRef: cursor.worktreeTreeSha,
      diff: page.patch,
      diffHash,
      truncated: page.truncated,
      nextCursor,
      snapshotId: cursor.snapshotId,
      stats: {
        fileCount: manifest.length,
        additions: stats.insertions,
        deletions: stats.deletions,
      },
    };
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [source],
    };
  });

  const getReviewDiffPreview = Effect.fn("getReviewDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const details = yield* statusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    if (input.pagination?.sourceKind === "working-tree") {
      return yield* getPagedReviewWorkingTreeDiff(input);
    }

    const branch = details.branch;
    const baseRef =
      input.baseRef ??
      (branch
        ? yield* resolveBaseBranchForNoUpstream(input.cwd, branch).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null);

    if (input.pagination?.sourceKind === "branch-range") {
      if (baseRef === null && input.pagination.cursor === undefined) {
        const emptyDiffHash = yield* hashReviewDiffValue(input.cwd, "");
        const source: ReviewDiffPreviewSource = {
          id: "branch-range",
          kind: "branch-range",
          title: "Against base branch",
          baseRef: null,
          headRef: branch ?? "HEAD",
          diff: "",
          diffHash: emptyDiffHash,
          truncated: false,
          nextCursor: null,
          snapshotId: emptyDiffHash,
          stats: { fileCount: 0, additions: 0, deletions: 0 },
        };
        return {
          cwd: input.cwd,
          generatedAt: yield* DateTime.now,
          sources: [source],
        };
      }
      return yield* getPagedReviewBranchDiff(input, baseRef);
    }

    const dirtyTrackedResult = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.dirtyTracked",
      input.cwd,
      [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        "HEAD",
        "--",
      ],
      {
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.orElseSucceed(() => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
    );
    const dirtyUntracked = yield* readUntrackedReviewDiffs(input.cwd).pipe(
      Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
    );
    const dirtyDiff = [dirtyTrackedResult.stdout.trimEnd(), dirtyUntracked.diff.trimEnd()]
      .filter((diff) => diff.length > 0)
      .join("\n");

    const baseResult =
      baseRef && branch
        ? yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.base",
            input.cwd,
            [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--minimal",
              ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
              `${baseRef}...HEAD`,
            ],
            {
              maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
              appendTruncationMarker: true,
            },
          ).pipe(
            Effect.orElseSucceed(() => ({
              exitCode: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          )
        : null;
    const baseDiff = baseResult?.stdout ?? "";
    const hashDiff = (diff: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(diff)).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.hash",
              command: "crypto.digest SHA-256",
              cwd: input.cwd,
              detail: "Failed to hash review diff.",
              cause,
            }),
        ),
      );
    const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(dirtyDiff),
      hashDiff(baseDiff),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: dirtyDiff,
        diffHash: dirtyDiffHash,
        truncated: dirtyTrackedResult.stdoutTruncated || dirtyUntracked.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: baseRef ? `Against ${baseRef}` : "Against base branch",
        baseRef,
        headRef: branch ?? "HEAD",
        diff: baseDiff,
        diffHash: baseDiffHash,
        truncated: baseResult?.stdoutTruncated ?? false,
      },
    ];

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    };
  });

  const reviewDiffFileError = (
    input: ReviewDiffFileContentsInput,
    detail: string,
    cause?: unknown,
  ) =>
    new GitCommandError({
      operation: "GitVcsDriver.getReviewDiffFileContents",
      command: "git",
      cwd: input.cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const isPathWithinRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const readReviewFileAtRevision = Effect.fn("readReviewFileAtRevision")(function* (
    input: ReviewDiffFileContentsInput,
    revision: string,
    relativePath: string,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.getReviewDiffFileContents.revision",
      input.cwd,
      ["show", `${revision}:${relativePath}`],
      { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.stdout.includes("\0")) {
      return yield* reviewDiffFileError(input, `Cannot expand binary file '${relativePath}'.`);
    }
    return result.stdout;
  });

  const readWorkingTreeReviewFile = Effect.fn("readWorkingTreeReviewFile")(function* (
    input: ReviewDiffFileContentsInput,
    repositoryRoot: string,
  ) {
    const fileError = (stage: string, detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: `GitVcsDriver.getReviewDiffFileContents.workingTree.${stage}`,
        command: stage,
        cwd: input.cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const requestedPath = path.resolve(repositoryRoot, input.newPath);
    if (!isPathWithinRoot(repositoryRoot, requestedPath)) {
      return yield* fileError(
        "path.resolve",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const [realRepositoryRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(requestedPath),
    ]).pipe(
      Effect.mapError((cause) =>
        fileError("fs.realPath", `Could not resolve diff file '${input.newPath}'.`, cause),
      ),
    );
    if (!isPathWithinRoot(realRepositoryRoot, realTarget)) {
      return yield* fileError(
        "fs.realPath",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const info = yield* fileSystem
      .stat(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.stat", `Could not inspect diff file '${input.newPath}'.`, cause),
        ),
      );
    if (info.type !== "File") {
      return yield* fileError("fs.stat", `Diff path '${input.newPath}' is not a file.`);
    }
    if (info.size > BigInt(REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES)) {
      return yield* fileError(
        "fs.stat",
        `Diff file '${input.newPath}' exceeds the 1 MB expansion limit.`,
      );
    }

    const bytes = yield* fileSystem
      .readFile(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.readFile", `Could not read diff file '${input.newPath}'.`, cause),
        ),
      );
    if (bytes.includes(0)) {
      return yield* fileError("fs.readFile", `Cannot expand binary file '${input.newPath}'.`);
    }
    return new TextDecoder("utf-8").decode(bytes);
  });

  const getReviewDiffFileContents = Effect.fn("getReviewDiffFileContents")(function* (
    input: ReviewDiffFileContentsInput,
  ) {
    if (input.sourceKind === "working-tree") {
      const repositoryRoot =
        input.headRef === null
          ? yield* runGitStdout(
              "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
              input.cwd,
              ["rev-parse", "--show-toplevel"],
            ).pipe(Effect.map((value) => value.trim()))
          : null;
      if (repositoryRoot !== null && repositoryRoot.length === 0) {
        return yield* reviewDiffFileError(input, "Could not resolve the Git repository root.");
      }
      const newContentsEffect =
        input.changeType === "deleted"
          ? Effect.succeed("")
          : input.headRef !== null
            ? readReviewFileAtRevision(input, input.headRef, input.newPath)
            : repositoryRoot !== null
              ? readWorkingTreeReviewFile(input, repositoryRoot)
              : Effect.fail(
                  reviewDiffFileError(input, "Could not resolve the working-tree diff source."),
                );
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new"
            ? Effect.succeed("")
            : readReviewFileAtRevision(input, input.baseRef ?? "HEAD", input.oldPath),
          newContentsEffect,
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }

    if (!input.baseRef || !input.headRef) {
      return yield* reviewDiffFileError(
        input,
        "Branch diff file expansion requires both base and head refs.",
      );
    }
    const mergeBase = yield* runGitStdout(
      "GitVcsDriver.getReviewDiffFileContents.mergeBase",
      input.cwd,
      ["merge-base", input.baseRef, input.headRef],
    ).pipe(Effect.map((value) => value.trim()));
    if (mergeBase.length === 0) {
      return yield* reviewDiffFileError(input, "Could not resolve the branch comparison base.");
    }
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, mergeBase, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, input.headRef, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const listHistory: GitVcsDriver.GitVcsDriver["Service"]["listHistory"] = Effect.fn("listHistory")(
    function* (input: GitVcsDriver.GitListHistoryRepositoryInput) {
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? GIT_HISTORY_DEFAULT_LIMIT;
      const headResult = yield* executeGit(
        "GitVcsDriver.listHistory.head",
        input.cwd,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 1_024,
        },
      );
      if (headResult.stdoutTruncated) {
        return yield* malformedGitHistoryOutput(
          input.cwd,
          "Git HEAD output exceeded the configured response limit.",
        );
      }
      const headSha =
        headResult.exitCode === 0
          ? yield* decodeGitObjectId(headResult.stdout.trim()).pipe(
              Effect.mapError((cause) =>
                malformedGitHistoryOutput(
                  input.cwd,
                  "Git returned an invalid HEAD object ID.",
                  cause,
                ),
              ),
            )
          : null;
      const publicRevisionArgs = [
        ...(headSha === null ? [] : ["HEAD"]),
        "--branches",
        "--remotes",
        "--tags",
      ];
      const historyEffect = executeGit(
        "GitVcsDriver.listHistory.log",
        input.cwd,
        [
          "log",
          "--topo-order",
          "--no-color",
          "--no-decorate",
          "--no-show-signature",
          "--no-patch",
          `--skip=${cursor}`,
          `--max-count=${limit + 1}`,
          "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00",
          ...publicRevisionArgs,
        ],
        {
          timeoutMs: 30_000,
          maxOutputBytes: GIT_HISTORY_MAX_OUTPUT_BYTES,
          fallbackErrorDetail: "Git history enumeration failed.",
        },
      );
      const refsEffect = executeGit(
        "GitVcsDriver.listHistory.refs",
        input.cwd,
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00",
          "refs/heads",
          "refs/remotes",
          "refs/tags",
        ],
        {
          timeoutMs: 30_000,
          maxOutputBytes: GIT_HISTORY_MAX_OUTPUT_BYTES,
          fallbackErrorDetail: "Git history ref enumeration failed.",
        },
      );
      const totalCountEffect =
        cursor === 0
          ? executeGit(
              "GitVcsDriver.listHistory.count",
              input.cwd,
              ["rev-list", "--count", ...publicRevisionArgs],
              {
                timeoutMs: 5_000,
                maxOutputBytes: 64,
                fallbackErrorDetail: "Git history count failed.",
              },
            ).pipe(
              Effect.flatMap((countResult) =>
                decodeGitHistoryTotalCount(countResult.stdout.trim()).pipe(
                  Effect.mapError((cause) =>
                    malformedGitHistoryOutput(
                      input.cwd,
                      "Git returned an invalid history commit count.",
                      cause,
                    ),
                  ),
                ),
              ),
              Effect.catch((error) =>
                Effect.logWarning(
                  `GitVcsDriver.listHistory: commit count unavailable for ${input.cwd}: ${error.message}`,
                ).pipe(Effect.as(null)),
              ),
            )
          : Effect.succeed(null);
      const [result, refsResult, totalCount] = yield* Effect.all(
        [historyEffect, refsEffect, totalCountEffect],
        {
          concurrency: 3,
        },
      );
      const parsedRefs = yield* parseGitHistoryRefsOutput({
        cwd: input.cwd,
        stdout: refsResult.stdout,
        stdoutTruncated: refsResult.stdoutTruncated,
      });
      const parsedCommits = yield* parseGitHistoryLogOutput({
        cwd: input.cwd,
        stdout: result.stdout,
        stdoutTruncated: result.stdoutTruncated,
      });
      const hasNextPage = parsedCommits.length > limit;
      const refsBySha = indexGitHistoryRefs(parsedRefs);
      const commits = parsedCommits.slice(0, limit).map((commit) => ({
        ...commit,
        refs: refsBySha.get(commit.sha) ?? [],
      }));

      return {
        commits,
        headSha,
        nextCursor: hasNextPage ? cursor + commits.length : null,
        totalCount,
      } satisfies GitListHistoryResult;
    },
  );

  const resolveCommitParents = Effect.fn("resolveCommitParents")(function* (input: {
    readonly cwd: string;
    readonly sha: string;
  }) {
    const operation = "GitVcsDriver.resolveCommitParents";
    const result = yield* executeGit(operation, input.cwd, [
      "rev-list",
      "--parents",
      "--max-count=1",
      input.sha,
    ]);
    const objectIds = result.stdout.trim().split(" ").filter(Boolean);
    if (objectIds.length === 0) {
      return yield* gitCommitReadError(
        operation,
        input.cwd,
        "git rev-list",
        "Git did not resolve the requested commit.",
      );
    }
    const decoded = yield* Effect.forEach(objectIds, (objectId) =>
      decodeGitObjectId(objectId).pipe(
        Effect.mapError((cause) =>
          gitCommitReadError(
            operation,
            input.cwd,
            "git rev-list",
            "Git returned an invalid commit object ID.",
            cause,
          ),
        ),
      ),
    );
    return { sha: decoded[0]!, parentShas: decoded.slice(1) };
  });

  const readCommitDetail: GitVcsDriver.GitVcsDriver["Service"]["getCommitDetail"] = Effect.fn(
    "getCommitDetail",
  )(function* (input) {
    const operation = "GitVcsDriver.getCommitDetail";
    const [metadataResult, numstatResult] = yield* Effect.all(
      [
        executeGit(
          `${operation}.metadata`,
          input.cwd,
          [
            "show",
            "-s",
            "--no-color",
            "--no-show-signature",
            "--format=%H%x00%P%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00",
            input.sha,
          ],
          {
            timeoutMs: 15_000,
            maxOutputBytes: GIT_COMMIT_DETAIL_MAX_OUTPUT_BYTES,
            fallbackErrorDetail: "Failed to read commit metadata.",
          },
        ),
        executeGit(
          `${operation}.numstat`,
          input.cwd,
          [
            "diff-tree",
            "--root",
            "--first-parent",
            "--no-commit-id",
            "--numstat",
            "-z",
            "-r",
            "-M",
            "-C",
            input.sha,
          ],
          {
            timeoutMs: 15_000,
            maxOutputBytes: GIT_COMMIT_DETAIL_MAX_OUTPUT_BYTES,
            fallbackErrorDetail: "Failed to read commit statistics.",
          },
        ),
      ],
      { concurrency: 2 },
    );
    if (metadataResult.stdoutTruncated || numstatResult.stdoutTruncated) {
      return yield* gitCommitReadError(
        operation,
        input.cwd,
        "git show",
        "Commit metadata exceeded the configured response limit.",
      );
    }
    const fields = metadataResult.stdout.split("\0");
    if (fields.length < 10) {
      return yield* gitCommitReadError(
        operation,
        input.cwd,
        "git show",
        "Git returned incomplete commit metadata.",
      );
    }
    const stats = parseCommitNumstat(numstatResult.stdout);
    return yield* decodeGitCommitDetail({
      sha: fields[0],
      parentShas: (fields[1] ?? "").split(" ").filter(Boolean),
      subject: truncateGitHistoryField(fields[2] ?? "", GIT_HISTORY_SUBJECT_MAX_LENGTH),
      body: fields[3] ?? "",
      authorName: truncateGitHistoryField(fields[4] ?? "", GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH),
      authorEmail: truncateGitHistoryField(fields[5] ?? "", GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH),
      authoredAt: truncateGitHistoryField(fields[6] ?? "", GIT_HISTORY_AUTHORED_AT_MAX_LENGTH),
      committerName: truncateGitHistoryField(fields[7] ?? "", GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH),
      committerEmail: truncateGitHistoryField(fields[8] ?? "", GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH),
      committedAt: truncateGitHistoryField(fields[9] ?? "", GIT_HISTORY_AUTHORED_AT_MAX_LENGTH),
      ...stats,
    }).pipe(
      Effect.mapError((cause) =>
        gitCommitReadError(
          operation,
          input.cwd,
          "git show",
          "Git returned invalid commit metadata.",
          cause,
        ),
      ),
    );
  });

  const getCommitDiff: GitVcsDriver.GitVcsDriver["Service"]["getCommitDiff"] = Effect.fn(
    "getCommitDiff",
  )(function* (input) {
    const commit = yield* resolveCommitParents(input);
    const baseSha = commit.parentShas[0] ?? null;
    const args =
      baseSha === null
        ? [
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--patch",
            "-r",
            "-M",
            "-C",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            input.sha,
            "--",
          ]
        : [
            "diff",
            "--patch",
            "-M",
            "-C",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            baseSha,
            input.sha,
            "--",
          ];
    const result = yield* executeGit("GitVcsDriver.getCommitDiff", input.cwd, args, {
      timeoutMs: 30_000,
      maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
      appendTruncationMarker: true,
      fallbackErrorDetail: "Failed to read the historical commit diff.",
    });
    const diffHash = yield* crypto.digest("SHA-256", new TextEncoder().encode(result.stdout)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError((cause) =>
        gitCommitReadError(
          "GitVcsDriver.getCommitDiff",
          input.cwd,
          "crypto.digest SHA-256",
          "Failed to hash the historical commit diff.",
          cause,
        ),
      ),
    );
    return {
      sha: commit.sha,
      baseSha,
      comparison: baseSha === null ? "root" : "first-parent",
      diff: result.stdout,
      diffHash,
      truncated: result.stdoutTruncated,
    } satisfies GitGetCommitDiffResult;
  });

  const getCommitDiffFileContents: GitVcsDriver.GitVcsDriver["Service"]["getCommitDiffFileContents"] =
    Effect.fn("getCommitDiffFileContents")(function* (input) {
      const operation = "GitVcsDriver.getCommitDiffFileContents";
      const commit = yield* resolveCommitParents(input);
      const manifestResult = yield* executeGit(
        `${operation}.manifest`,
        input.cwd,
        [
          "diff-tree",
          "--root",
          "--first-parent",
          "--no-commit-id",
          "--name-status",
          "-z",
          "-r",
          "-M",
          "-C",
          input.sha,
        ],
        {
          timeoutMs: 15_000,
          maxOutputBytes: GIT_COMMIT_DETAIL_MAX_OUTPUT_BYTES,
          fallbackErrorDetail: "Failed to validate the historical diff file.",
        },
      );
      if (manifestResult.stdoutTruncated) {
        return yield* gitCommitReadError(
          operation,
          input.cwd,
          "git diff-tree",
          "Commit file manifest exceeded the configured response limit.",
        );
      }
      const manifest = parseCommitChangedPaths(manifestResult.stdout);
      const requestedFile = manifest.find((file) => {
        if (input.changeType === "new") {
          return file.status === "A" && file.newPath === input.newPath;
        }
        if (input.changeType === "deleted") {
          return file.status === "D" && file.oldPath === input.oldPath;
        }
        return file.oldPath === input.oldPath && file.newPath === input.newPath;
      });
      if (!requestedFile) {
        return yield* gitCommitReadError(
          operation,
          input.cwd,
          "git diff-tree",
          "The requested file does not belong to this commit diff.",
        );
      }

      const readAtRevision = Effect.fn("readCommitDiffFileAtRevision")(function* (
        revision: string,
        relativePath: string,
      ) {
        const result = yield* executeGit(
          `${operation}.read`,
          input.cwd,
          ["show", `${revision}:${relativePath}`],
          { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
        );
        if (result.stdoutTruncated) {
          return yield* gitCommitReadError(
            operation,
            input.cwd,
            "git show",
            `Diff file '${relativePath}' exceeds the 1 MB expansion limit.`,
          );
        }
        if (result.stdout.includes("\0")) {
          return yield* gitCommitReadError(
            operation,
            input.cwd,
            "git show",
            `Cannot expand binary file '${relativePath}'.`,
          );
        }
        return result.stdout;
      });

      const baseSha = commit.parentShas[0] ?? null;
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" || baseSha === null
            ? Effect.succeed("")
            : readAtRevision(baseSha, input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readAtRevision(input.sha, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    });

  const readGitRefsSnapshot = Effect.fn("readGitRefsSnapshot")(function* (gitCommonDir: string) {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    const gitDirArgs = ["--git-dir", gitCommonDir] as const;
    const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.listRefs.snapshotRefs",
          fetchCwd,
          [
            ...gitDirArgs,
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads",
            "refs/remotes",
          ],
          {
            timeoutMs: 30_000,
            maxOutputBytes: 16 * 1024 * 1024,
            fallbackErrorDetail: "Git ref snapshot enumeration failed.",
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.defaultRef",
          fetchCwd,
          [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.worktreeList",
          fetchCwd,
          [...gitDirArgs, "worktree", "list", "--porcelain", "-z"],
          {
            timeoutMs: 30_000,
            allowNonZeroExit: true,
            maxOutputBytes: 16 * 1024 * 1024,
          },
        ),
        executeGit("GitVcsDriver.listRefs.remoteNames", fetchCwd, [...gitDirArgs, "remote"], {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: 2 },
    );

    const remoteNames =
      remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;
    const parsedWorktreeEntries =
      worktreeListResult.exitCode === 0
        ? [...parseWorktreeBranchPaths(worktreeListResult.stdout)].map(
            ([branchName, worktreePath]) =>
              [branchName, path.normalize(path.resolve(worktreePath))] as const,
          )
        : [];
    const existingWorktreeEntries = yield* Effect.filter(
      parsedWorktreeEntries,
      ([, worktreePath]) =>
        fileSystem.stat(worktreePath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: 16 },
    );
    const worktreeMap = new Map(existingWorktreeEntries);
    const localBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
    const remoteBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];

    for (const line of refsResult.stdout.split("\n")) {
      if (line.length === 0) continue;
      const [fullRefName, lastCommitRaw, symbolicTarget] = line.split("\t");
      if (!fullRefName || symbolicTarget) continue;
      const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

      if (fullRefName.startsWith("refs/heads/")) {
        const name = fullRefName.slice("refs/heads/".length);
        localBranches.push({
          ref: {
            name,
            current: false,
            isRemote: false,
            isDefault: name === defaultBranch,
            worktreePath: worktreeMap.get(name) ?? null,
          },
          lastCommit,
        });
        continue;
      }
      if (!fullRefName.startsWith("refs/remotes/")) continue;

      const name = fullRefName.slice("refs/remotes/".length);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
      const remoteBranch: VcsRef = {
        name,
        current: false,
        isRemote: true,
        isDefault:
          defaultBranch !== null &&
          parsedRemoteRef?.remoteName === "origin" &&
          parsedRemoteRef.branchName === defaultBranch,
        worktreePath: null,
        ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
      };
      remoteBranches.push({ ref: remoteBranch, lastCommit });
    }

    const byRecencyThenName = (
      left: { readonly ref: VcsRef; readonly lastCommit: number },
      right: { readonly ref: VcsRef; readonly lastCommit: number },
    ) =>
      left.lastCommit !== right.lastCommit
        ? right.lastCommit - left.lastCommit
        : left.ref.name.localeCompare(right.ref.name);

    return {
      localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      hasPrimaryRemote: remoteNames.includes("origin"),
    } satisfies GitRefsSnapshot;
  });

  const listRefsEpochByCommonDir = new Map<string, number>();
  let listRefsEpochSequence = 0;
  const bumpListRefsEpoch = (gitCommonDir: string): number => {
    const nextEpoch = ++listRefsEpochSequence;
    listRefsEpochByCommonDir.delete(gitCommonDir);
    listRefsEpochByCommonDir.set(gitCommonDir, nextEpoch);
    if (listRefsEpochByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsEpochByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsEpochByCommonDir.delete(oldestKey);
      }
    }
    return nextEpoch;
  };
  const listRefsGenerationByCommonDir = new Map<string, number>();
  let listRefsGenerationSequence = 0;
  const setListRefsGeneration = (gitCommonDir: string, generation: number): number => {
    listRefsGenerationByCommonDir.delete(gitCommonDir);
    listRefsGenerationByCommonDir.set(gitCommonDir, generation);
    if (listRefsGenerationByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsGenerationByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsGenerationByCommonDir.delete(oldestKey);
      }
    }
    return generation;
  };
  const currentListRefsGeneration = (gitCommonDir: string): number => {
    const current = listRefsGenerationByCommonDir.get(gitCommonDir);
    return current === undefined
      ? setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence)
      : setListRefsGeneration(gitCommonDir, current);
  };
  const bumpListRefsGeneration = (gitCommonDir: string): number =>
    setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence);
  const listRefsSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsSnapshotCacheKey) => readGitRefsSnapshot(cacheKey.gitCommonDir),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
    },
  );
  const listRefsRefreshSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsRefreshCacheKey) =>
      Effect.suspend(() => {
        const epoch = bumpListRefsEpoch(cacheKey.gitCommonDir);
        return Cache.get(
          listRefsSnapshotCache,
          new GitRefsSnapshotCacheKey({ gitCommonDir: cacheKey.gitCommonDir, epoch }),
        );
      }),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? LIST_REFS_REFRESH_COALESCE_TTL : LIST_REFS_REFRESH_FAILURE_COOLDOWN,
    },
  );
  const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
    gitCommonDir: string,
    refresh: boolean,
  ) {
    while (true) {
      const generation = currentListRefsGeneration(gitCommonDir);
      const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);
      const snapshot =
        refresh || currentEpoch === undefined
          ? // The refresh cache owns the complete snapshot read, rather than only the
            // epoch bump. Slow repositories therefore remain singleflight for the
            // entire Git scan even when more refresh requests arrive after the
            // coalescing TTL would otherwise have elapsed.
            yield* Cache.get(
              listRefsRefreshSnapshotCache,
              new GitRefsRefreshCacheKey({ gitCommonDir, generation }),
            )
          : yield* Cache.get(
              listRefsSnapshotCache,
              new GitRefsSnapshotCacheKey({ gitCommonDir, epoch: currentEpoch }),
            );
      if (currentListRefsGeneration(gitCommonDir) === generation) {
        return snapshot;
      }
    }
  });
  const invalidateListRefsSnapshot = Effect.fn("invalidateListRefsSnapshot")(function* (
    cwd: string,
  ) {
    const repositoryPathsCacheKey = normalizeRepositoryPathsCacheKey(cwd);
    const repositoryPaths = yield* Cache.get(repositoryPathsCache, repositoryPathsCacheKey);
    if (repositoryPaths === null) return;
    const previousGeneration = currentListRefsGeneration(repositoryPaths.gitCommonDir);
    bumpListRefsGeneration(repositoryPaths.gitCommonDir);
    bumpListRefsEpoch(repositoryPaths.gitCommonDir);
    yield* Cache.invalidate(
      listRefsRefreshSnapshotCache,
      new GitRefsRefreshCacheKey({
        gitCommonDir: repositoryPaths.gitCommonDir,
        generation: previousGeneration,
      }),
    );
    yield* Cache.invalidate(repositoryPathsRefreshCache, repositoryPathsCacheKey);
    yield* Cache.invalidate(repositoryPathsCache, repositoryPathsCacheKey);
  });

  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const repositoryPaths = yield* resolveRepositoryPaths(input.cwd, input.refresh === true).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (repositoryPaths === null) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }

      const snapshot = yield* resolveListRefsSnapshot(
        repositoryPaths.gitCommonDir,
        input.refresh === true,
      );
      const hasCurrentWorktreeBranch =
        repositoryPaths.worktreeRoot !== null &&
        snapshot.localBranches.some((ref) => ref.worktreePath === repositoryPaths.worktreeRoot);
      const localBranches = snapshot.localBranches.map((ref) => ({
        ...ref,
        current: hasCurrentWorktreeBranch
          ? ref.worktreePath === repositoryPaths.worktreeRoot
          : ref.name === repositoryPaths.currentBranch,
      }));
      const combinedBranches = input.includeMatchingRemoteRefs
        ? [...localBranches, ...snapshot.remoteBranches]
        : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]);
      // Keep current/default refs on the first page even when the default
      // only exists as origin/<default> (remote refs sort after all locals).
      const allBranches = combinedBranches.toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        return leftPriority - rightPriority;
      });
      const branchesForKind =
        input.refKind === "local"
          ? allBranches.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? allBranches.filter((ref) => ref.isRemote)
            : allBranches;
      const refs = paginateBranches({
        refs: filterBranchesForListQuery(branchesForKind, input.query),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: snapshot.hasPrimaryRemote,
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
    const args = input.newRefName
      ? ["worktree", "add", "-b", input.newRefName, worktreePath, input.refName]
      : ["worktree", "add", worktreePath, input.refName];

    yield* executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
      fallbackErrorDetail: "git worktree add failed",
    });

    if (input.newRefName && input.baseRefName) {
      const remoteNames = yield* listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => []));
      const parsedBaseRef = parseRemoteRefWithRemoteNames(
        input.baseRefName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const baseBranch = parsedBaseRef?.branchName ?? input.baseRefName;
      yield* runGit("GitVcsDriver.createWorktree.configureBaseRef", input.cwd, [
        "config",
        `branch.${input.newRefName}.gh-merge-base`,
        baseBranch,
      ]);
    }

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorDetail: "git fetch pull request branch failed",
        },
      );
    });

  const resolveCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveCommit"] = Effect.fn(
    "resolveCommit",
  )(function* (input) {
    const commitSha = yield* runGitStdout("GitVcsDriver.resolveCommit", input.cwd, [
      "rev-parse",
      "--verify",
      `${input.revision}^{commit}`,
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const fetchPullRequestHeadCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestHeadCommit"] =
    Effect.fn("fetchPullRequestHeadCommit")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      // No refspec destination: the pull head lands in FETCH_HEAD (per worktree) instead of a
      // branch, which is the only way to read it while that branch is checked out somewhere.
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestHeadCommit",
        input.cwd,
        ["fetch", "--quiet", "--no-tags", remoteName, `refs/pull/${input.prNumber}/head`],
        {
          fallbackErrorDetail: "git fetch pull request head failed",
        },
      );

      return yield* resolveCommit({ cwd: input.cwd, revision: "FETCH_HEAD" });
    });

  const refreshCheckedOutBranch: GitVcsDriver.GitVcsDriver["Service"]["refreshCheckedOutBranch"] =
    Effect.fn("refreshCheckedOutBranch")(function* (input) {
      const { commitSha: headCommit } = yield* resolveCommit({ cwd: input.cwd, revision: "HEAD" });
      if (headCommit === input.targetCommit) {
        return { headCommit, moved: false, onTarget: true };
      }

      const worktreeChanges = yield* runGitStdout(
        "GitVcsDriver.refreshCheckedOutBranch.status",
        input.cwd,
        ["status", "--porcelain"],
      );
      if (worktreeChanges.trim().length > 0) {
        return { headCommit, moved: false, onTarget: false };
      }

      const isAncestor = yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.isAncestor",
        input.cwd,
        ["merge-base", "--is-ancestor", headCommit, input.targetCommit],
        { allowNonZeroExit: true },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      // A rewritten head (rebase, squash, amend) does not descend from the checkout, so it can
      // only be taken by resetting. That is lossless exactly when the tree is clean and HEAD
      // never left the commit the upstream held before the fetch.
      if (!isAncestor && headCommit !== input.resetWhenHeadCommit) {
        return { headCommit, moved: false, onTarget: false };
      }

      if (!isAncestor) {
        // The commit being reset away is about to be reachable from nothing. It is only ever a
        // commit the remote already held, but "the remote held it" stops being a way back once
        // the head it belonged to has been rewritten, so a ref keeps it findable.
        yield* executeGit(
          "GitVcsDriver.refreshCheckedOutBranch.keepPrevious",
          input.cwd,
          ["update-ref", "refs/t3code/pre-refresh", headCommit],
          { fallbackErrorDetail: "git failed to record the previous checkout commit" },
        );
      }

      yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.move",
        input.cwd,
        // `--merge` rather than `--hard`: the cleanliness check above is a snapshot, and another
        // thread may edit a tracked file between it and this move. Git itself refuses a `--merge`
        // reset that would overwrite such an edit — the same guarantee `--ff-only` gives the
        // other branch — so a race loses nothing; the refresh fails and is reported instead.
        isAncestor
          ? ["merge", "--ff-only", input.targetCommit]
          : ["reset", "--merge", input.targetCommit],
        {
          timeoutMs: 30_000,
          fallbackErrorDetail: "git failed to move the checkout onto the pull request head",
        },
      );

      return { headCommit: input.targetCommit, moved: true, onTarget: true };
    });

  const fetchRemote: GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"] = Effect.fn("fetchRemote")(
    function* (input) {
      yield* executeGit(
        "GitVcsDriver.fetchRemote",
        input.cwd,
        ["fetch", "--quiet", input.remoteName],
        {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
        },
      );
    },
  );

  const fetchAll: GitVcsDriver.GitVcsDriver["Service"]["fetchAll"] = Effect.fn("fetchAll")(
    function* (input) {
      yield* executeGit("GitVcsDriver.fetchAll", input.cwd, ["fetch", "--all", "--quiet"], {
        env: STATUS_UPSTREAM_REFRESH_ENV,
        fallbackErrorDetail: "git fetch --all failed",
      });
    },
  );

  const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
    Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
      const remoteNames = yield* listRemoteNames(input.cwd);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(
        input.refName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const remoteRefName =
        parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;
      const commitSha = yield* runGitStdout("GitVcsDriver.resolveRemoteTrackingCommit", input.cwd, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remoteRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha, remoteRefName };
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      localBranchAlreadyExists
        ? ["branch", "--force", input.localBranch, targetRef]
        : ["branch", input.localBranch, targetRef],
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    yield* executeGit("GitVcsDriver.removeWorktree", input.cwd, args, {
      timeoutMs: 15_000,
      fallbackErrorDetail: "git worktree remove failed",
    });
  });

  const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
    "renameBranch",
  )(function* (input) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }
    const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

    yield* executeGit(
      "GitVcsDriver.renameBranch",
      input.cwd,
      ["branch", "-m", "--", input.oldBranch, targetBranch],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch rename failed",
      },
    );

    return { branch: targetBranch };
  });

  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git checkout failed",
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch create failed",
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git init failed",
    }).pipe(Effect.asVoid);

  const discardWorkingTree: GitVcsDriver.GitVcsDriver["Service"]["discardWorkingTree"] = Effect.fn(
    "GitVcsDriver.discardWorkingTree",
  )(function* (cwd) {
    const head = yield* executeGit(
      "GitVcsDriver.discardWorkingTree.resolveHead",
      cwd,
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 4_096 },
    );

    if (head.exitCode === 0) {
      yield* executeGit("GitVcsDriver.discardWorkingTree.reset", cwd, ["reset", "--hard", "HEAD"], {
        timeoutMs: 30_000,
        fallbackErrorDetail: "Failed to restore tracked files to HEAD.",
      });
    } else {
      // An unborn repository has no HEAD to reset to. Emptying its index leaves every
      // staged path untracked so the following clean removes it as well.
      yield* executeGit(
        "GitVcsDriver.discardWorkingTree.emptyIndex",
        cwd,
        ["read-tree", "--empty"],
        {
          timeoutMs: 30_000,
          fallbackErrorDetail: "Failed to clear the repository index.",
        },
      );
    }

    yield* executeGit("GitVcsDriver.discardWorkingTree.clean", cwd, ["clean", "-fd"], {
      timeoutMs: 30_000,
      fallbackErrorDetail: "Failed to remove untracked files.",
    });
  });

  const listLocalBranchNames: GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"] = (
    cwd,
  ) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) => {
        const branchNames: Array<string> = [];
        for (const line of stdout.split("\n")) {
          const branchName = line.trim();
          if (branchName.length > 0) {
            branchNames.push(branchName);
          }
        }
        return branchNames;
      }),
    );

  const withListRefsInvalidation = <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.ensuring(
        Effect.all([
          invalidateListRefsSnapshot(cwd).pipe(Effect.ignore),
          invalidateStatusStaticCaches(cwd).pipe(Effect.ignore),
        ]),
      ),
    );
  const initRepoWithListRefsInvalidation: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (
    input,
  ) =>
    initRepo(input).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const cacheKey = normalizeRepositoryPathsCacheKey(input.cwd);
          yield* Cache.invalidate(repositoryPathsRefreshCache, cacheKey);
          yield* Cache.invalidate(repositoryPathsCache, cacheKey);
          yield* invalidateListRefsSnapshot(input.cwd).pipe(Effect.ignore);
        }),
      ),
    );

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    prepareCommitContext,
    commit: (cwd, subject, body, options) =>
      withListRefsInvalidation(cwd, commit(cwd, subject, body, options)),
    pushCurrentBranch: (cwd, fallbackBranch, options) =>
      withListRefsInvalidation(cwd, pushCurrentBranch(cwd, fallbackBranch, options)),
    pullCurrentBranch: (cwd) => withListRefsInvalidation(cwd, pullCurrentBranch(cwd)),
    discardWorkingTree,
    readRangeContext,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    readConfigValue,
    listHistory,
    getCommitDetail: readCommitDetail,
    getCommitDiff,
    getCommitDiffFileContents,
    listRefs,
    createWorktree: (input) => withListRefsInvalidation(input.cwd, createWorktree(input)),
    fetchPullRequestBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchPullRequestBranch(input)),
    fetchPullRequestHeadCommit,
    resolveCommit,
    refreshCheckedOutBranch: (input) =>
      withListRefsInvalidation(input.cwd, refreshCheckedOutBranch(input)),
    ensureRemote: (input) => withListRefsInvalidation(input.cwd, ensureRemote(input)),
    resolvePrimaryRemoteName,
    fetchAll: (input) => withListRefsInvalidation(input.cwd, fetchAll(input)),
    fetchRemote: (input) => withListRefsInvalidation(input.cwd, fetchRemote(input)),
    remoteExists,
    resolveRemoteTrackingCommit,
    fetchRemoteBranch: (input) => withListRefsInvalidation(input.cwd, fetchRemoteBranch(input)),
    fetchRemoteTrackingBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input)),
    setBranchUpstream: (input) => withListRefsInvalidation(input.cwd, setBranchUpstream(input)),
    removeWorktree: (input) => withListRefsInvalidation(input.cwd, removeWorktree(input)),
    renameBranch: (input) => withListRefsInvalidation(input.cwd, renameBranch(input)),
    createRef: (input) => withListRefsInvalidation(input.cwd, createRef(input)),
    switchRef: (input) => withListRefsInvalidation(input.cwd, switchRef(input)),
    initRepo: initRepoWithListRefsInvalidation,
    listLocalBranchNames,
  });
});
