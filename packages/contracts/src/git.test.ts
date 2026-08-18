import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GIT_HISTORY_AUTHOR_EMAIL_MAX_LENGTH,
  GIT_HISTORY_AUTHOR_NAME_MAX_LENGTH,
  GIT_HISTORY_AUTHORED_AT_MAX_LENGTH,
  GIT_HISTORY_CWD_MAX_LENGTH,
  GIT_HISTORY_MAX_LIMIT,
  GIT_HISTORY_REF_LABEL_MAX_LENGTH,
  GIT_HISTORY_SUBJECT_MAX_LENGTH,
  GitHistoryCommitSummary,
  GitGetCommitDetailInput,
  GitGetCommitDiffFileContentsInput,
  GitGetCommitDiffResult,
  GitListHistoryInput,
  GitListHistoryResult,
  GitObjectId,
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsStatusLocalResult,
} from "./git.ts";

const SHA_1 = "0123456789abcdef0123456789abcdef01234567";
const PARENT_SHA_1 = "89abcdef0123456789abcdef0123456789abcdef";
const SHA_256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const decodeObjectId = Schema.decodeUnknownSync(GitObjectId);
const decodeHistoryCommitSummary = Schema.decodeUnknownSync(GitHistoryCommitSummary);
const decodeListHistoryInput = Schema.decodeUnknownSync(GitListHistoryInput);
const decodeListHistoryResult = Schema.decodeUnknownSync(GitListHistoryResult);
const decodeCommitDetailInput = Schema.decodeUnknownSync(GitGetCommitDetailInput);
const decodeCommitDiffFileContentsInput = Schema.decodeUnknownSync(
  GitGetCommitDiffFileContentsInput,
);
const decodeCommitDiffResult = Schema.decodeUnknownSync(GitGetCommitDiffResult);
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
const decodeVcsStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);

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

describe("VcsStatusLocalResult", () => {
  const baseStatus = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: { insertions: 1, deletions: 0 },
  };

  it("carries working-tree presentation status while accepting legacy files", () => {
    const current = decodeVcsStatusLocalResult({
      ...baseStatus,
      workingTree: {
        ...baseStatus.workingTree,
        files: [{ path: "new.ts", status: "untracked", insertions: 1, deletions: 0 }],
      },
    });
    const legacy = decodeVcsStatusLocalResult({
      ...baseStatus,
      workingTree: {
        ...baseStatus.workingTree,
        files: [{ path: "old.ts", insertions: 1, deletions: 0 }],
      },
    });

    expect(current.workingTree.files[0]?.status).toBe("untracked");
    expect(legacy.workingTree.files[0]?.status).toBeUndefined();
  });

  it("rejects unsupported working-tree presentation status", () => {
    expect(() =>
      decodeVcsStatusLocalResult({
        ...baseStatus,
        workingTree: {
          ...baseStatus.workingTree,
          files: [{ path: "copied.ts", status: "copied", insertions: 1, deletions: 0 }],
        },
      }),
    ).toThrow();
  });
});

describe("GitListHistoryInput", () => {
  it("round-trips a bounded page request", () => {
    const decoded = decodeListHistoryInput({
      projectId: "project-1",
      threadId: "thread-1",
      cwd: "/repo/worktree",
      cursor: 100,
      limit: GIT_HISTORY_MAX_LIMIT,
    });

    expect(encodeListHistoryInput(decoded)).toEqual({
      projectId: "project-1",
      threadId: "thread-1",
      cwd: "/repo/worktree",
      cursor: 100,
      limit: GIT_HISTORY_MAX_LIMIT,
    });
  });

  it.each([
    { projectId: "project-1", cwd: "/repo", cursor: -1 },
    { projectId: "project-1", cwd: "/repo", limit: 0 },
    { projectId: "project-1", cwd: "/repo", limit: GIT_HISTORY_MAX_LIMIT + 1 },
    { projectId: "project-1", cwd: "x".repeat(GIT_HISTORY_CWD_MAX_LENGTH + 1) },
    { cwd: "/repo" },
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
      refs: [
        { kind: "branch", label: "feat/history" },
        { kind: "remote", label: "origin/main" },
        { kind: "tag", label: "v1.0.0" },
      ],
    };

    const decoded = decodeHistoryCommitSummary(input);

    expect(encodeHistoryCommitSummary(decoded)).toEqual(input);
  });

  it("keeps empty display fields representable and defaults legacy refs", () => {
    const decoded = decodeHistoryCommitSummary({
      sha: SHA_1,
      parentShas: [],
      subject: "",
      authorName: "",
      authorEmail: "",
      authoredAt: "2026-08-09T14:30:00Z",
    });

    expect(decoded).toMatchObject({ subject: "", authorName: "", authorEmail: "" });
    expect(decoded.refs).toEqual([]);
  });

  it("rejects invalid or oversized refs", () => {
    const input = {
      sha: SHA_1,
      parentShas: [],
      subject: "subject",
      authorName: "author",
      authorEmail: "author@example.com",
      authoredAt: "2026-08-09T14:30:00Z",
    };

    expect(() =>
      decodeHistoryCommitSummary({
        ...input,
        refs: [{ kind: "other", label: "main" }],
      }),
    ).toThrow();
    expect(() =>
      decodeHistoryCommitSummary({
        ...input,
        refs: [{ kind: "branch", label: "x".repeat(GIT_HISTORY_REF_LABEL_MAX_LENGTH + 1) }],
      }),
    ).toThrow();
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
          refs: [{ kind: "branch", label: "main" }],
        },
      ],
      headSha: SHA_1,
      nextCursor: 100,
      totalCount: 1_234,
    };

    const decoded = decodeListHistoryResult(input);

    expect(encodeListHistoryResult(decoded)).toEqual(input);
  });

  it("round-trips integration branch divergence when present", () => {
    const input = {
      commits: [],
      headSha: SHA_1,
      nextCursor: null,
      totalCount: 1,
      comparison: { base: "upstream/main", ahead: 2, behind: 3 },
    };

    expect(encodeListHistoryResult(decodeListHistoryResult(input))).toEqual(input);
  });
});

describe("historical commit resources", () => {
  it("accepts only complete object IDs and bounded file requests", () => {
    expect(
      decodeCommitDetailInput({ projectId: "project-1", cwd: "/repo", sha: SHA_1 }),
    ).toMatchObject({ sha: SHA_1 });
    expect(
      decodeCommitDiffFileContentsInput({
        projectId: "project-1",
        cwd: "/repo",
        sha: SHA_1,
        changeType: "rename-changed",
        oldPath: "old name.ts",
        newPath: "new name.ts",
      }),
    ).toMatchObject({ oldPath: "old name.ts", newPath: "new name.ts" });
    expect(() =>
      decodeCommitDetailInput({ projectId: "project-1", cwd: "/repo", sha: "HEAD~1" }),
    ).toThrow();
    expect(() =>
      decodeCommitDiffFileContentsInput({
        projectId: "project-1",
        cwd: "/repo",
        sha: SHA_1,
        changeType: "change",
        oldPath: "",
        newPath: "file.ts",
      }),
    ).toThrow();
  });

  it("represents root and first-parent patches", () => {
    expect(
      decodeCommitDiffResult({
        sha: SHA_1,
        baseSha: null,
        comparison: "root",
        diff: "diff --git a/file.ts b/file.ts",
        diffHash: "hash",
        truncated: false,
      }),
    ).toMatchObject({ comparison: "root", baseSha: null });
    expect(
      decodeCommitDiffResult({
        sha: SHA_1,
        baseSha: PARENT_SHA_1,
        comparison: "first-parent",
        diff: "",
        diffHash: "hash",
        truncated: true,
      }),
    ).toMatchObject({ comparison: "first-parent", baseSha: PARENT_SHA_1 });
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
