import type { FileDiffContentsLoader } from "@pierre/diffs";
import type {
  EnvironmentId,
  GitObjectId,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  CopyIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildFileDiffRenderKey,
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "../diffs/AnnotatableCodeView";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle-group";

type DiffThemeType = "light" | "dark";

export function GitCommitPanel({
  environmentId,
  projectId,
  threadId,
  cwd,
  sha,
  composerDraftTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly cwd: string;
  readonly sha: GitObjectId;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const diffRenderMode = useDiffPanelStore((state) => state.diffRenderMode);
  const setDiffRenderMode = useDiffPanelStore((state) => state.setDiffRenderMode);
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [collapsedFileKeys, setCollapsedFileKeys] = useState<ReadonlySet<string>>(() => new Set());
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "commit SHA" });
  const resourceInput = useMemo(
    () => ({
      projectId,
      ...(threadId !== null ? { threadId } : {}),
      cwd,
      sha,
    }),
    [cwd, projectId, sha, threadId],
  );
  const detail = useEnvironmentQuery(
    gitEnvironment.commitDetail({ environmentId, input: resourceInput }),
  );
  const commitDiff = useEnvironmentQuery(
    gitEnvironment.commitDiff({ environmentId, input: resourceInput }),
  );
  const getFileContents = useAtomCommand(gitEnvironment.commitDiffFileContents);
  const renderablePatch = useMemo(
    () => getRenderablePatch(commitDiff.data?.diff, `git-commit:${sha}`),
    [commitDiff.data?.diff, sha],
  );
  const files = useMemo(() => {
    if (renderablePatch?.kind !== "files") return [];
    return renderablePatch.files
      .toSorted((left, right) =>
        resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        return {
          fileDiff,
          fileKey,
          filePath: resolveFileDiffPath(fileDiff),
          collapsed: collapsedFileKeys.has(fileKey),
        };
      });
  }, [collapsedFileKeys, renderablePatch]);
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const resolvedDiff = commitDiff.data;
    if (!resolvedDiff) return undefined;
    return async (fileDiff) => {
      const newPath = resolveFileDiffPath(fileDiff);
      const oldPath = fileDiff.prevName
        ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
        : newPath;
      const result = await getFileContents({
        environmentId,
        input: {
          ...resourceInput,
          changeType: fileDiff.type,
          oldPath,
          newPath,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const newFile = {
        name: newPath,
        contents: result.value.newContents,
        cacheKey: `${resolvedDiff.diffHash}:new:${newPath}`,
      };
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      return {
        oldFile: {
          name: oldPath,
          contents: result.value.oldContents,
          cacheKey: `${resolvedDiff.diffHash}:old:${oldPath}`,
        },
        newFile,
      };
    };
  }, [commitDiff.data, environmentId, getFileContents, resourceInput]);

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{sha.slice(0, 7)}</span>
        <span className="min-w-0 truncate text-xs font-medium">
          {detail.data?.subject || "Commit diff"}
        </span>
        <Button
          aria-label={isCopied ? "Commit SHA copied" : "Copy full commit SHA"}
          size="icon-xs"
          variant="ghost"
          onClick={() => copyToClipboard(sha, undefined)}
        >
          <CopyIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          aria-label="Stacked diff view"
          size="icon-xs"
          variant={diffRenderMode === "stacked" ? "secondary" : "ghost"}
          onClick={() => setDiffRenderMode("stacked")}
        >
          <Rows3Icon aria-hidden="true" className="size-3.5" />
        </Button>
        <Button
          aria-label="Split diff view"
          size="icon-xs"
          variant={diffRenderMode === "split" ? "secondary" : "ghost"}
          onClick={() => setDiffRenderMode("split")}
        >
          <Columns2Icon aria-hidden="true" className="size-3.5" />
        </Button>
        <Toggle
          aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          pressed={wordWrap}
          size="sm"
          variant="ghost"
          onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
        >
          <TextWrapIcon aria-hidden="true" className="size-3.5" />
        </Toggle>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode="embedded" header={header}>
      {detail.data ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          <span>{detail.data.authorName || "Unknown author"}</span>
          <span className="px-1.5">·</span>
          <span>{detail.data.changedFileCount} files</span>
          <span className="px-1.5 text-success">+{detail.data.insertions}</span>
          <span className="text-destructive">−{detail.data.deletions}</span>
          {commitDiff.data?.comparison === "first-parent" && detail.data.parentShas.length > 1 ? (
            <span className="ml-2">Changes against first parent</span>
          ) : null}
        </div>
      ) : null}
      {commitDiff.data?.truncated ? (
        <p className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          This diff was truncated because it exceeded the preview limit.
        </p>
      ) : null}
      {commitDiff.error || detail.error ? (
        <div className="px-3 py-2 text-xs text-destructive" role="alert">
          {commitDiff.error ?? detail.error}
        </div>
      ) : null}
      {!renderablePatch ? (
        commitDiff.isPending ? (
          <DiffPanelLoadingState label="Loading commit diff…" />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-muted-foreground">
            No patch available for this commit.
          </div>
        )
      ) : renderablePatch.kind === "files" ? (
        <AnnotatableCodeView
          viewerRef={codeViewRef}
          codeViewKey={`${sha}:${commitDiff.data?.diffHash ?? "pending"}:${diffRenderMode}:${wordWrap}`}
          className="diff-render-surface h-full min-h-0 flex-1 overflow-auto"
          composerDraftTarget={composerDraftTarget}
          files={files}
          sectionId={`commit:${sha}`}
          sectionTitle={detail.data?.subject || `Commit ${sha.slice(0, 7)}`}
          renderHeaderPrefix={(_fileDiff, fileKey, collapsed) => (
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded-sm text-xs hover:bg-foreground/10"
              aria-label={collapsed ? "Expand file diff" : "Collapse file diff"}
              onClick={(event) => {
                event.stopPropagation();
                setCollapsedFileKeys((current) => {
                  const next = new Set(current);
                  if (next.has(fileKey)) next.delete(fileKey);
                  else next.add(fileKey);
                  return next;
                });
              }}
            >
              {collapsed ? (
                <ChevronRightIcon aria-hidden="true" className="size-4" />
              ) : (
                <ChevronDownIcon aria-hidden="true" className="size-4" />
              )}
            </button>
          )}
          options={{
            diffStyle: diffRenderMode === "split" ? "split" : "unified",
            lineDiffType: "none",
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme as DiffThemeType,
            unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
            stickyHeaders: true,
            ...(loadDiffFiles ? { loadDiffFiles } : {}),
            itemMetrics: {
              diffHeaderHeight: 32,
              hunkSeparatorHeight: 24,
              paddingTop: 0,
              paddingBottom: 0,
            },
            layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
          }}
        />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] text-muted-foreground">
          {renderablePatch.text}
        </pre>
      )}
    </DiffPanelShell>
  );
}
