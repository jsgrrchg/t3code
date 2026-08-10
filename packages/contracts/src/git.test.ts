import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH,
  GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH,
  GIT_HISTORY_AUTHORED_AT_MAX_LENGTH,
  GIT_HISTORY_CWD_MAX_LENGTH,
  GIT_HISTORY_MAX_LIMIT,
  GIT_HISTORY_SUBJECT_MAX_LENGTH,
  GitHistoryCommitSummary,
  GitListHistoryInput,
  GitListHistoryResult,
  GitObjectId,
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
} from "./git.ts";

const SHA_1 = "0123456789abcdef0123456789abcdef01234567";
const PARENT_SHA_1 = "89abcdef0123456789abcdef0123456789abcdef";
const SHA_256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const decodeObjectId = Schema.decodeUnknownSync(GitObjectId);
const decodeHistoryCommitSummary = Schema.decodeUnknownSync(GitHistoryCommitSummary);
const decodeListHistoryInput = Schema.decodeUnknownSync(GitListHistoryInput);
const decodeListHistoryResult = Schema.decodeUnknownSync(GitListHistoryResult);
const encodeHistoryCommitSummary = Schema.encodeSync(GitHistoryCommitSummary);
const encodeListHistoryInput = Schema.encodeSync(GitListHistoryInput);
const encodeListHistoryResult = Schema.encodeSync(GitListHistoryResult);

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("GitObjectId", () => {
  it("accepts complete SHA-1 and SHA-256 object IDs", () => {
    expect(decodeObjectId(SHA_1)).toBe(SHA_1);
    expect(decodeObjectId(SHA_256)).toBe(SHA_256);
    expect(decodeObjectId(SHA_1.toUpperCase())).toBe(SHA_1.toUpperCase());
  });

  it.each(["0123456", `${SHA_1.slice(0, -1)}g`, `${SHA_256}0`, "HEAD"])(
    "rejects an invalid object ID: %s",
    (value) => {
      expect(() => decodeObjectId(value)).toThrow();
    },
  );
});

describe("GitListHistoryInput", () => {
  it("round-trips a bounded page request", () => {
    const decoded = decodeListHistoryInput({
      cwd: "/repo/worktree",
      cursor: 100,
      limit: GIT_HISTORY_MAX_LIMIT,
    });

    expect(encodeListHistoryInput(decoded)).toEqual({
      cwd: "/repo/worktree",
      cursor: 100,
      limit: GIT_HISTORY_MAX_LIMIT,
    });
  });

  it.each([
    { cwd: "/repo", cursor: -1 },
    { cwd: "/repo", limit: 0 },
    { cwd: "/repo", limit: GIT_HISTORY_MAX_LIMIT + 1 },
    { cwd: "x".repeat(GIT_HISTORY_CWD_MAX_LENGTH + 1) },
  ])("rejects an invalid page request: $input", (input) => {
    expect(() => decodeListHistoryInput(input)).toThrow();
  });
});

describe("GitHistoryCommitSummary", () => {
  it("round-trips the graph and display metadata", () => {
    const input = {
      sha: SHA_1,
      parentShas: [PARENT_SHA_1],
      subject: "feat: dibujar caminos Git 🌿",
      authorName: "José 李",
      authorEmail: "josé@example.com",
      authoredAt: "2026-08-09T14:30:00-04:00",
    };

    const decoded = decodeHistoryCommitSummary(input);

    expect(encodeHistoryCommitSummary(decoded)).toEqual(input);
  });

  it("keeps empty subject and author fields representable", () => {
    expect(
      decodeHistoryCommitSummary({
        sha: SHA_1,
        parentShas: [],
        subject: "",
        authorName: "",
        authorEmail: "",
        authoredAt: "2026-08-09T14:30:00Z",
      }),
    ).toMatchObject({ subject: "", authorName: "", authorEmail: "" });
  });

  it.each([
    { field: "subject", maxLength: GIT_HISTORY_SUBJECT_MAX_LENGTH },
    { field: "authorName", maxLength: GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH },
    { field: "authorEmail", maxLength: GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH },
    { field: "authoredAt", maxLength: GIT_HISTORY_AUTHORED_AT_MAX_LENGTH },
  ] as const)("rejects $field beyond its wire limit", ({ field, maxLength }) => {
    expect(() =>
      decodeHistoryCommitSummary({
        sha: SHA_1,
        parentShas: [],
        subject: "subject",
        authorName: "author",
        authorEmail: "author@example.com",
        authoredAt: "2026-08-09T14:30:00Z",
        [field]: "x".repeat(maxLength + 1),
      }),
    ).toThrow();
  });
});

describe("GitListHistoryResult", () => {
  it("round-trips a history page without arbitrary Git revisions", () => {
    const input = {
      commits: [
        {
          sha: SHA_1,
          parentShas: [PARENT_SHA_1],
          subject: "feat: add history contracts",
          authorName: "T3 Code",
          authorEmail: "dev@example.com",
          authoredAt: "2026-08-09T14:30:00Z",
        },
      ],
      headSha: SHA_1,
      nextCursor: 100,
    };

    const decoded = decodeListHistoryResult(input);

    expect(encodeListHistoryResult(decoded)).toEqual(input);
  });
});

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});
