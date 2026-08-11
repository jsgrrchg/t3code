import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectDeleteEntryInput,
  ProjectListEntriesInput,
  ProjectMoveEntryError,
  ProjectMoveEntryInput,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectWriteFileError,
} from "./project.ts";

const decodeListEntriesInput = Schema.decodeUnknownSync(ProjectListEntriesInput);
const decodeDeleteEntryInput = Schema.decodeUnknownSync(ProjectDeleteEntryInput);
const decodeMoveEntryInput = Schema.decodeUnknownSync(ProjectMoveEntryInput);
const decodeSearchEntriesInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);
const decodeSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);

describe("project search inputs", () => {
  it("accepts a file move with nested, spaced paths", () => {
    expect(
      decodeMoveEntryInput({
        cwd: "/workspace",
        sourceRelativePath: "src/my file (draft).ts",
        destinationRelativePath: "components/my file (draft).ts",
        kind: "file",
      }),
    ).toEqual({
      cwd: "/workspace",
      sourceRelativePath: "src/my file (draft).ts",
      destinationRelativePath: "components/my file (draft).ts",
      kind: "file",
    });
  });

  it("rejects invalid file move paths and unsupported kinds", () => {
    for (const path of ["", "   ", "a".repeat(513)]) {
      expect(() =>
        decodeMoveEntryInput({
          cwd: "/workspace",
          sourceRelativePath: path,
          destinationRelativePath: "destination.ts",
          kind: "file",
        }),
      ).toThrow();
      expect(() =>
        decodeMoveEntryInput({
          cwd: "/workspace",
          sourceRelativePath: "source.ts",
          destinationRelativePath: path,
          kind: "file",
        }),
      ).toThrow();
    }
    expect(() =>
      decodeMoveEntryInput({
        cwd: "/workspace",
        sourceRelativePath: "src",
        destinationRelativePath: "components/src",
        kind: "directory",
      }),
    ).toThrow();
  });

  it("requires the expected entry kind for workspace deletion", () => {
    expect(
      decodeDeleteEntryInput({ cwd: "/workspace", relativePath: "src", kind: "directory" }),
    ).toEqual({ cwd: "/workspace", relativePath: "src", kind: "directory" });
    expect(() =>
      decodeDeleteEntryInput({ cwd: "/workspace", relativePath: "src", kind: "other" }),
    ).toThrow();
  });
  it("keeps ignored workspace entries opt-in", () => {
    expect(decodeListEntriesInput({ cwd: "/workspace" })).toEqual({ cwd: "/workspace" });
    expect(decodeListEntriesInput({ cwd: "/workspace", includeIgnored: true }).includeIgnored).toBe(
      true,
    );
  });

  it("accepts a paginated directory listing target", () => {
    expect(
      decodeListEntriesInput({
        cwd: "/workspace",
        directory: "src/components",
        cursor: "Composer.tsx",
        includeIgnored: true,
      }),
    ).toEqual({
      cwd: "/workspace",
      directory: "src/components",
      cursor: "Composer.tsx",
      includeIgnored: true,
    });
  });

  it("allows an empty entries query for bounded frecency browsing", () => {
    const decoded = decodeSearchEntriesInput({
      cwd: "/workspace",
      query: "   ",
      limit: 10,
      kind: "file",
    });
    expect(decoded.query).toBe("");
  });

  it("keeps ignored search entries opt-in", () => {
    expect(decodeSearchEntriesInput({ cwd: "/workspace", query: "env", limit: 10 })).toEqual({
      cwd: "/workspace",
      query: "env",
      limit: 10,
    });
    expect(
      decodeSearchEntriesInput({
        cwd: "/workspace",
        query: "env",
        limit: 10,
        includeIgnored: true,
      }).includeIgnored,
    ).toBe(true);
  });

  it("preserves whitespace in content search queries", () => {
    const decoded = decodeSearchContentsInput({
      cwd: "/workspace",
      query: " foo ",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(decoded.query).toBe(" foo ");
  });
});

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);

    const contentSearchError = new ProjectSearchContentsError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 100,
      failure: "search_index_search_failed",
      cause,
    });
    expect(contentSearchError.message).toBe("Failed to search workspace contents in '/workspace'.");
    expect(contentSearchError.message).not.toContain(cause.message);
    expect(contentSearchError).not.toHaveProperty("query");
    expect(contentSearchError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);
    const decodeMoveError = Schema.decodeUnknownSync(ProjectMoveEntryError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });
    const moveError = decodeMoveError({
      _tag: "ProjectMoveEntryError",
      message: "Legacy project move failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
    expect(moveError.message).toBe("Legacy project move failure.");
    expect(moveError.sourceRelativePath).toBeUndefined();
    expect(moveError.destinationRelativePath).toBeUndefined();
    expect(moveError.failure).toBeUndefined();
  });

  it("derives a stable structured move error message", () => {
    const cause = new Error("sensitive platform detail");
    const moveError = new ProjectMoveEntryError({
      cwd: "/workspace",
      sourceRelativePath: "src/index.ts",
      destinationRelativePath: "components/index.ts",
      failure: "destination_exists",
      operation: "lstat-destination",
      operationPath: "/workspace/components/index.ts",
      cause,
    });

    expect(moveError.message).toBe(
      "Failed to move workspace file 'src/index.ts' to 'components/index.ts' in '/workspace'.",
    );
    expect(moveError.failure).toBe("destination_exists");
    expect(moveError.operation).toBe("lstat-destination");
    expect(moveError.cause).toBe(cause);
    expect(moveError.message).not.toContain(cause.message);
  });
});
