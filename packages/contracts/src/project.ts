import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_DELETE_ENTRY_PATH_MAX_LENGTH = 512;
const PROJECT_MOVE_ENTRY_PATH_MAX_LENGTH = 512;
const PROJECT_LIST_DIRECTORY_PATH_MAX_LENGTH = 512;
const PROJECT_LIST_DIRECTORY_CURSOR_MAX_LENGTH = 512;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // An empty query is a bounded browse: the index returns frecency-ordered
  // entries, which the file picker uses for its initial results.
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
  includeIgnored: Schema.optional(Schema.Boolean),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Whitespace is significant in content queries (" foo", regex trailing
  // spaces), so the query is deliberately not trimmed on the wire.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  includeIgnored: Schema.optional(Schema.Boolean),
  directory: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_LIST_DIRECTORY_PATH_MAX_LENGTH)),
  ),
  cursor: Schema.optional(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(PROJECT_LIST_DIRECTORY_CURSOR_MAX_LENGTH),
    ),
  ),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
  nextCursor: Schema.optional(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(PROJECT_LIST_DIRECTORY_CURSOR_MAX_LENGTH),
    ),
  ),
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "workspace_path_outside_root",
  "read_directory_failed",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode legacy message-only
  // failures. New application code must provide them through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedErrorClass<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace contents in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectDeleteEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_DELETE_ENTRY_PATH_MAX_LENGTH),
  ),
  kind: ProjectEntryKind,
});
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

export const ProjectDeleteEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectDeleteEntryResult = typeof ProjectDeleteEntryResult.Type;

export const ProjectMoveEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceRelativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_MOVE_ENTRY_PATH_MAX_LENGTH),
  ),
  destinationRelativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_MOVE_ENTRY_PATH_MAX_LENGTH),
  ),
  kind: Schema.Literal("file"),
});
export type ProjectMoveEntryInput = typeof ProjectMoveEntryInput.Type;

export const ProjectMoveEntryResult = Schema.Struct({
  sourceRelativePath: TrimmedNonEmptyString,
  destinationRelativePath: TrimmedNonEmptyString,
  kind: Schema.Literal("file"),
});
export type ProjectMoveEntryResult = typeof ProjectMoveEntryResult.Type;

export const ProjectMoveEntryFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "source_not_found",
  "source_kind_mismatch",
  "source_destination_same",
  "destination_exists",
  "destination_parent_not_found",
  "destination_parent_not_directory",
  "operation_failed",
]);
export type ProjectMoveEntryFailure = typeof ProjectMoveEntryFailure.Type;

export const ProjectMoveEntryOperation = Schema.Literals([
  "lstat-source",
  "lstat-destination",
  "lstat-destination-parent",
  "link-destination",
  "readlink-source",
  "realpath-workspace-root",
  "realpath-source-parent",
  "realpath-destination-parent",
  "rename",
  "rollback-destination",
  "symlink-destination",
  "unlink-source",
]);
export type ProjectMoveEntryOperation = typeof ProjectMoveEntryOperation.Type;

type ProjectMoveEntryFailureContext = {
  readonly cwd: string;
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
  readonly failure: ProjectMoveEntryFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectMoveEntryOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectMoveEntryError extends Schema.TaggedErrorClass<ProjectMoveEntryError>()(
  "ProjectMoveEntryError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    sourceRelativePath: Schema.optional(TrimmedNonEmptyString),
    destinationRelativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectMoveEntryFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectMoveEntryOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectMoveEntryFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to move workspace file '${props.sourceRelativePath}' to '${props.destinationRelativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "path_not_found",
  "path_kind_mismatch",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "lstat",
  "read",
  "close",
  "make-directory",
  "write-file",
  "remove",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectDeleteEntryError extends Schema.TaggedErrorClass<ProjectDeleteEntryError>()(
  "ProjectDeleteEntryError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to delete workspace entry '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
