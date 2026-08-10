// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const WORKSPACE_IGNORED_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const WORKSPACE_IGNORED_FILES_CACHE_CAPACITY = 16;
const WORKSPACE_IGNORED_FILES_CACHE_TTL = "3 seconds";
const WORKSPACE_DIRECTORY_PAGE_SIZE = 1_000;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

function parentProjectPath(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function projectEntryName(entry: ProjectEntry): string {
  return entry.path.slice(entry.path.lastIndexOf("/") + 1);
}

function compareProjectEntryNames(left: ProjectEntry, right: ProjectEntry): number {
  const leftName = projectEntryName(left);
  const rightName = projectEntryName(right);
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

function scoreProjectEntry(entry: ProjectEntry, query: string): number | null {
  if (!query) return 0;

  const path = entry.path.toLowerCase();
  const name = projectEntryName(entry).toLowerCase();
  let totalScore = 0;

  for (const term of query.split(/\s+/)) {
    const nameScore = scoreQueryMatch({
      value: name,
      query: term,
      exactBase: 0,
      prefixBase: 100,
      boundaryBase: 200,
      includesBase: 300,
      fuzzyBase: 500,
    });
    const pathScore = scoreQueryMatch({
      value: path,
      query: term,
      exactBase: 50,
      prefixBase: 150,
      boundaryBase: 250,
      includesBase: 350,
      fuzzyBase: 550,
    });
    const termScore =
      nameScore === null
        ? pathScore
        : pathScore === null
          ? nameScore
          : Math.min(nameScore, pathScore);
    if (termScore === null) return null;
    totalScore += termScore;
  }

  return totalScore;
}

function entryPassesSearchFilters(entry: ProjectEntry, input: ProjectSearchEntriesInput): boolean {
  if (input.kind !== undefined && entry.kind !== input.kind) return false;
  return !input.imageOnly || (entry.kind === "file" && isWorkspaceImagePreviewPath(entry.path));
}

function mergeIgnoredEntries(
  visible: ProjectListEntriesResult,
  ignored: ProjectListEntriesResult,
): ProjectListEntriesResult {
  const entryByPath = new Map(visible.entries.map((entry) => [entry.path, entry]));
  for (const entry of ignored.entries) {
    entryByPath.set(entry.path, entry);
    let parentPath = parentProjectPath(entry.path);
    while (parentPath) {
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentProjectPath(parentPath);
    }
  }
  const sortedEntries = [...entryByPath.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const entries = sortedEntries.slice(0, WorkspaceSearchIndex.WORKSPACE_INDEX_MAX_ENTRIES);
  return {
    entries,
    truncated: visible.truncated || ignored.truncated || entries.length < sortedEntries.length,
  };
}

function mergeSearchEntries(
  visible: ProjectSearchEntriesResult,
  ignored: ProjectListEntriesResult,
  input: ProjectSearchEntriesInput,
  normalizedQuery: string,
): ProjectSearchEntriesResult {
  const seen = new Set<string>();

  if (!normalizedQuery) {
    const entries: ProjectEntry[] = [];
    for (const entry of [...visible.entries, ...ignored.entries]) {
      if (seen.has(entry.path) || !entryPassesSearchFilters(entry, input)) continue;
      seen.add(entry.path);
      entries.push(entry);
    }
    return {
      entries: entries.slice(0, input.limit),
      truncated: visible.truncated || ignored.truncated || entries.length > input.limit,
    };
  }

  const ranked: Array<{ item: ProjectEntry; score: number; tieBreaker: string }> = [];
  let matchedCount = 0;
  for (const [visibleIndex, entry] of visible.entries.entries()) {
    if (seen.has(entry.path) || !entryPassesSearchFilters(entry, input)) continue;
    seen.add(entry.path);
    matchedCount += 1;
    insertRankedSearchResult(
      ranked,
      {
        item: entry,
        score: scoreProjectEntry(entry, normalizedQuery) ?? 10_000 + visibleIndex,
        tieBreaker: entry.path,
      },
      input.limit,
    );
  }
  for (const entry of ignored.entries) {
    if (seen.has(entry.path) || !entryPassesSearchFilters(entry, input)) continue;
    seen.add(entry.path);
    const score = scoreProjectEntry(entry, normalizedQuery);
    if (score === null) continue;
    matchedCount += 1;
    insertRankedSearchResult(ranked, { item: entry, score, tieBreaker: entry.path }, input.limit);
  }

  return {
    entries: ranked.map((entry) => entry.item),
    truncated: visible.truncated || ignored.truncated || matchedCount > input.limit,
  };
}

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedErrorClass<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedErrorClass<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspacePaths.WorkspacePathOutsideRootError,
  WorkspaceEntriesReadDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePath(input.cwd, path), input.partialPath);
});

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const listIgnoredEntries = Effect.fn("WorkspaceEntries.listIgnoredEntries")(function* (
    cwd: string,
  ) {
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredEntries",
        command: "git",
        cwd,
        args: [
          ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
          "ls-files",
          "--cached",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
        ],
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_IGNORED_FILES_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to list ignored workspace entries", { cwd, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
    if (result === null || result.exitCode !== 0) {
      return { entries: [], truncated: false };
    }

    const parts = result.stdout.split("\0");
    if (result.stdoutTruncated && parts.at(-1)?.length) {
      parts.pop();
    }
    const entries = parts.flatMap((relativePath) => {
      const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      const directory = normalizedPath.endsWith("/");
      const projectPath = normalizedPath.replace(/\/+$/, "");
      return projectPath
        ? [{ path: projectPath, kind: directory ? ("directory" as const) : ("file" as const) }]
        : [];
    });
    return { entries, truncated: result.stdoutTruncated };
  });
  const ignoredEntriesCache = yield* Cache.makeWith(
    (cwd: string) =>
      listIgnoredEntries(cwd).pipe(
        Effect.map((ignored) => mergeIgnoredEntries({ entries: [], truncated: false }, ignored)),
      ),
    {
      capacity: WORKSPACE_IGNORED_FILES_CACHE_CAPACITY,
      timeToLive: () => WORKSPACE_IGNORED_FILES_CACHE_TTL,
    },
  );

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const filterVisibleDirectoryEntries = Effect.fn("WorkspaceEntries.filterVisibleDirectoryEntries")(
    function* (cwd: string, entries: ReadonlyArray<ProjectEntry>) {
      if (entries.length === 0) return entries;
      const result = yield* vcsProcess
        .run({
          operation: "WorkspaceEntries.filterVisibleDirectoryEntries",
          command: "git",
          cwd,
          args: [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            "check-ignore",
            "--no-index",
            "-z",
            "--stdin",
          ],
          stdin: `${entries.map((entry) => entry.path).join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (result === null || (result.exitCode !== 0 && result.exitCode !== 1)) return entries;
      const ignoredPaths = new Set(result.stdout.split("\0").filter(Boolean));
      return entries.filter((entry) => !ignoredPaths.has(entry.path));
    },
  );

  const listDirectory = Effect.fn("WorkspaceEntries.listDirectory")(function* (
    normalizedCwd: string,
    input: ProjectListEntriesInput & { readonly directory: string },
  ) {
    const target =
      input.directory === "."
        ? { absolutePath: normalizedCwd, relativePath: "" }
        : yield* workspacePaths.resolveRelativePathWithinRoot({
            workspaceRoot: normalizedCwd,
            relativePath: input.directory,
          });
    const dirents = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(target.absolutePath, { withFileTypes: true }),
      catch: (cause) =>
        new WorkspaceEntriesReadDirectoryError({
          cwd: normalizedCwd,
          partialPath: input.directory,
          parentPath: target.absolutePath,
          cause,
        }),
    });
    const sortedEntries = dirents
      .flatMap((dirent): ProjectEntry[] => {
        if (dirent.name === ".git") return [];
        if (!dirent.isDirectory() && !dirent.isFile() && !dirent.isSymbolicLink()) return [];
        const projectPath = target.relativePath
          ? `${target.relativePath}/${dirent.name}`
          : dirent.name;
        return [{ path: projectPath, kind: dirent.isDirectory() ? "directory" : "file" }];
      })
      .toSorted(compareProjectEntryNames);
    const visibleEntries = input.includeIgnored
      ? sortedEntries
      : yield* filterVisibleDirectoryEntries(normalizedCwd, sortedEntries);
    const cursor = input.cursor;
    const startIndex = cursor
      ? visibleEntries.findIndex((entry) => projectEntryName(entry) > cursor)
      : 0;
    const pageStart = startIndex === -1 ? visibleEntries.length : startIndex;
    const entries = visibleEntries.slice(pageStart, pageStart + WORKSPACE_DIRECTORY_PAGE_SIZE);
    const hasMore = pageStart + entries.length < visibleEntries.length;
    return {
      entries,
      truncated: hasMore,
      ...(hasMore && entries.length > 0 ? { nextCursor: projectEntryName(entries.at(-1)!) } : {}),
    };
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      yield* Cache.invalidate(ignoredEntriesCache, normalizedCwd);
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        const visible = yield* searchIndex.search(
          normalizedQuery,
          input.limit,
          input.kind,
          input.imageOnly,
        );
        if (!input.includeIgnored) return visible;
        const ignored = yield* Cache.get(ignoredEntriesCache, normalizedCwd);
        return mergeSearchEntries(visible, ignored, input, normalizedQuery);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directory !== undefined) {
        return yield* listDirectory(normalizedCwd, {
          ...input,
          directory: input.directory,
        });
      }
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        const visible = yield* searchIndex.list();
        if (!input.includeIgnored) return visible;
        const ignored = yield* Cache.get(ignoredEntriesCache, normalizedCwd);
        return mergeIgnoredEntries(visible, ignored);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
