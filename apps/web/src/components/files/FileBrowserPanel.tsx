import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeDropTarget,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { resolvePathAgainstCwd } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import { Eye, EyeOff, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Toggle } from "~/components/ui/toggle";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { toPierreGitStatus } from "./fileTreeGitStatus";
import { fileTreeDirectoryDropTarget, resolveFileTreeMove } from "./fileTreeMove";
import { loadProjectDirectoryEntries } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  /** Changes when a completed turn may have added or removed workspace entries. */
  refreshToken: string | null;
  onOpenFile: (relativePath: string) => void;
  onBeforeDeleteEntry: (relativePath: string, kind: ProjectEntry["kind"]) => Promise<void>;
  onEntryDeleted: (relativePath: string, kind: ProjectEntry["kind"]) => void;
  workspaceEntryMoveEnabled: boolean;
  pendingFileSurfaceIds: ReadonlySet<string>;
  onBeforeMoveEntry: (
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<boolean>;
  onEntryMoved: (sourceRelativePath: string, destinationRelativePath: string) => void;
  onMoveSettled: () => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

const INCLUDE_IGNORED_STORAGE_KEY = "t3code.fileBrowser.includeIgnored";
const FILE_TREE_SEARCH_LIMIT = 200;
const PROJECT_ROOT_DROP_TARGET: FileTreeDropTarget = {
  kind: "root",
  directoryPath: null,
  flattenedSegmentPath: null,
  hoveredPath: null,
};

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function ShowIgnoredFilesButton(props: {
  includeIgnored: boolean;
  onIncludeIgnoredChange: (includeIgnored: boolean) => void;
}) {
  const label = props.includeIgnored ? "Hide ignored files" : "Show ignored files";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            type="button"
            variant="ghost"
            size="xs"
            pressed={props.includeIgnored}
            aria-label={label}
            onPressedChange={props.onIncludeIgnoredChange}
          >
            {props.includeIgnored ? <Eye /> : <EyeOff />}
          </Toggle>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1 rounded-md">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  refreshToken,
  onOpenFile,
  onBeforeDeleteEntry,
  onEntryDeleted,
  workspaceEntryMoveEnabled,
  pendingFileSurfaceIds,
  onBeforeMoveEntry,
  onEntryMoved,
  onMoveSettled,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  // Showing ignored files is an explorer preference, not a property of one
  // thread. Persist it so switching chats does not silently reset the tree.
  const [includeIgnored, setIncludeIgnored] = useLocalStorage(
    INCLUDE_IGNORED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const deleteEntry = useAtomCommand(projectEnvironment.deleteEntry);
  const moveEntry = useAtomCommand(projectEnvironment.moveEntry);
  const refreshGitStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const gitStatus = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const pierreGitStatus = useMemo(
    () => toPierreGitStatus(gitStatus.data?.workingTree.files ?? []),
    [gitStatus.data?.workingTree.files],
  );
  const [movePending, setMovePending] = useState(false);
  const [treeDragActive, setTreeDragActive] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const normalizedSearchValue = searchValue.trim();
  const searchActive = normalizedSearchValue.length > 0;
  const pathSearch = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query: searchValue,
      includeIgnored,
    },
    FILE_TREE_SEARCH_LIMIT,
  );
  const [treeRevision, setTreeRevision] = useState(0);
  const [rootError, setRootError] = useState<string | null>(null);
  const [pendingDirectoryCount, setPendingDirectoryCount] = useState(0);
  const loadedEntryKindsRef = useRef(new Map<string, ProjectEntry["kind"]>());
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(new Map());
  const loadedDirectoriesRef = useRef(new Set<string>());
  const loadingDirectoriesRef = useRef(new Map<string, Promise<void>>());
  const treeGenerationRef = useRef(0);
  const searchActiveRef = useRef(searchActive);
  const previousSearchActiveRef = useRef(false);
  searchActiveRef.current = searchActive;
  const refreshTreeRef = useRef<() => void>(() => undefined);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const lastAutoRefreshTokenRef = useRef(refreshToken);
  const movePolicyRef = useRef({
    workspaceEntryMoveEnabled,
    pendingFileSurfaceIds,
    selectedPath,
    movePending,
  });
  movePolicyRef.current = {
    workspaceEntryMoveEnabled,
    pendingFileSurfaceIds,
    selectedPath,
    movePending,
  };
  const moveCallbacksRef = useRef({ onBeforeMoveEntry, onEntryMoved, onMoveSettled });
  moveCallbacksRef.current = { onBeforeMoveEntry, onEntryMoved, onMoveSettled };

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const kind = entryKindsRef.current.get(relativePath);
    if (!kind) {
      context.close();
      return;
    }
    const absolutePath = resolvePathAgainstCwd(relativePath, cwd);
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-path", label: "Copy path", icon: "copy" },
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
          { id: "delete", label: "Delete", destructive: true, icon: "trash" },
        ],
        position,
      );
      if (clicked === "copy-path") {
        try {
          await writeTextToClipboard(absolutePath, "file path");
          toastManager.add({
            type: "success",
            title: "Path copied",
            description: absolutePath,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
        return;
      }
      if (clicked === "delete") {
        const confirmed = await api.dialogs.confirm(
          kind === "directory"
            ? `Delete folder "${relativePath}" and all of its contents? This cannot be undone.`
            : `Delete file "${relativePath}"? This cannot be undone.`,
        );
        if (!confirmed) return;

        await onBeforeDeleteEntry(relativePath, kind);
        const result = await deleteEntry({
          environmentId,
          input: { cwd, relativePath, kind },
        });
        if (result._tag === "Success") {
          onEntryDeleted(relativePath, kind);
          refreshTreeRef.current();
          toastManager.add({
            type: "success",
            title: kind === "directory" ? "Folder deleted" : "File deleted",
            description: relativePath,
          });
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: kind === "directory" ? "Failed to delete folder" : "Failed to delete file",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const resolveMove = useCallback((context: FileTreeDropContext) => {
    const policy = movePolicyRef.current;
    return resolveFileTreeMove(context, {
      enabled: policy.workspaceEntryMoveEnabled,
      movePending: policy.movePending,
      entryKinds: entryKindsRef.current,
      pendingSurfaceIds: policy.pendingFileSurfaceIds,
      activeRelativePath: policy.selectedPath,
    });
  }, []);
  const completeMoveRef = useRef<(event: FileTreeDropResult) => void>(() => undefined);
  completeMoveRef.current = (event) => {
    const move = resolveMove(event);
    if (!move) {
      refreshTreeRef.current();
      return;
    }
    movePolicyRef.current = { ...movePolicyRef.current, movePending: true };
    setMovePending(true);
    void (async () => {
      try {
        const canContinue = await moveCallbacksRef.current.onBeforeMoveEntry(
          move.sourceRelativePath,
          move.destinationRelativePath,
        );
        if (!canContinue) {
          toastManager.add({
            type: "error",
            title: "File not moved",
            description: "Save the file before moving it.",
          });
          return;
        }
        const result = await moveEntry({
          environmentId,
          input: { cwd, ...move, kind: "file" },
        });
        if (result._tag === "Success") {
          moveCallbacksRef.current.onEntryMoved(
            result.value.sourceRelativePath,
            result.value.destinationRelativePath,
          );
          toastManager.add({
            type: "success",
            title: "File moved",
            description: result.value.destinationRelativePath,
          });
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to move file",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to move file",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      } finally {
        moveCallbacksRef.current.onMoveSettled();
        movePolicyRef.current = { ...movePolicyRef.current, movePending: false };
        setMovePending(false);
        refreshTreeRef.current();
      }
    })();
  };
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    dragAndDrop: {
      canDrop: (context) => resolveMove(context) !== null,
      onDropComplete: (event) => completeMoveRef.current(event),
      onDropError: (error) => {
        refreshTreeRef.current();
        toastManager.add({ type: "error", title: "Failed to move file", description: error });
      },
    },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  useEffect(() => {
    model.setGitStatus(pierreGitStatus);
  }, [model, pierreGitStatus]);
  const loadDirectory = useCallback(
    (directory: string, refresh = false): Promise<void> => {
      if (!refresh && loadedDirectoriesRef.current.has(directory)) return Promise.resolve();
      const existing = loadingDirectoriesRef.current.get(directory);
      if (existing) return existing;
      const generation = treeGenerationRef.current;
      setPendingDirectoryCount((count) => count + 1);
      const request = loadProjectDirectoryEntries(environmentId, cwd, directory, includeIgnored, {
        refresh,
      })
        .then((entries) => {
          if (treeGenerationRef.current !== generation) return;
          const additions: ProjectEntry[] = [];
          for (const entry of entries) {
            if (loadedEntryKindsRef.current.has(entry.path)) continue;
            loadedEntryKindsRef.current.set(entry.path, entry.kind);
            additions.push(entry);
          }
          loadedDirectoriesRef.current.add(directory);
          if (!searchActiveRef.current && additions.length > 0) {
            entryKindsRef.current = loadedEntryKindsRef.current;
            model.batch(
              additions.map((entry) => ({ type: "add" as const, path: treePath(entry) })),
            );
          }
          if (directory.length === 0) setRootError(null);
          setTreeRevision((revision) => revision + 1);
        })
        .catch((error: unknown) => {
          if (treeGenerationRef.current !== generation) return;
          const message = error instanceof Error ? error.message : "Failed to load directory.";
          if (directory.length === 0) {
            setRootError(message);
          } else {
            toastManager.add({
              type: "error",
              title: "Failed to load folder",
              description: message,
            });
          }
        })
        .finally(() => {
          if (treeGenerationRef.current === generation) {
            loadingDirectoriesRef.current.delete(directory);
            setPendingDirectoryCount((count) => Math.max(0, count - 1));
          }
        });
      loadingDirectoriesRef.current.set(directory, request);
      return request;
    },
    [cwd, environmentId, includeIgnored, model],
  );

  const refreshTree = useCallback(() => {
    treeGenerationRef.current += 1;
    loadedEntryKindsRef.current = new Map();
    entryKindsRef.current = loadedEntryKindsRef.current;
    loadedDirectoriesRef.current = new Set();
    loadingDirectoriesRef.current = new Map();
    setPendingDirectoryCount(0);
    setRootError(null);
    if (!searchActiveRef.current) model.resetPaths([]);
    setTreeRevision((revision) => revision + 1);
    void loadDirectory("", true);
  }, [loadDirectory, model]);
  const refreshListedFiles = useCallback(() => {
    refreshTree();
    if (searchActive) pathSearch.refresh();
  }, [pathSearch.refresh, refreshTree, searchActive]);
  const refreshFiles = useCallback(() => {
    refreshListedFiles();
    void refreshGitStatus({ environmentId, input: { cwd } });
  }, [cwd, environmentId, refreshGitStatus, refreshListedFiles]);
  refreshTreeRef.current = refreshFiles;

  useEffect(() => {
    if (refreshToken === null || lastAutoRefreshTokenRef.current === refreshToken) {
      return;
    }
    lastAutoRefreshTokenRef.current = refreshToken;
    refreshListedFiles();
  }, [refreshListedFiles, refreshToken]);

  useEffect(() => {
    refreshTree();
    return () => {
      treeGenerationRef.current += 1;
    };
  }, [refreshTree]);

  const loadDirectoryRef = useRef(loadDirectory);
  useEffect(() => {
    loadDirectoryRef.current = loadDirectory;
  }, [loadDirectory]);
  useEffect(
    () =>
      model.subscribe(() => {
        if (searchActiveRef.current) return;
        for (const [path, kind] of loadedEntryKindsRef.current) {
          if (
            kind !== "directory" ||
            loadedDirectoriesRef.current.has(path) ||
            loadingDirectoriesRef.current.has(path)
          ) {
            continue;
          }
          const item = model.getItem(`${path}/`) ?? model.getItem(path);
          if (item && "isExpanded" in item && item.isExpanded()) {
            void loadDirectoryRef.current(path);
          }
        }
      }),
    [model],
  );

  useEffect(() => {
    const previousSearchActive = previousSearchActiveRef.current;
    previousSearchActiveRef.current = searchActive;
    if (!searchActive) {
      if (!previousSearchActive) return;
      entryKindsRef.current = loadedEntryKindsRef.current;
      model.resetPaths(
        [...loadedEntryKindsRef.current].map(([path, kind]) => treePath({ path, kind })),
      );
      setTreeRevision((revision) => revision + 1);
      return;
    }
    if (pathSearch.isPending || pathSearch.searchedQuery !== normalizedSearchValue) return;
    const searchKinds = new Map<string, ProjectEntry["kind"]>();
    for (const entry of pathSearch.entries) {
      searchKinds.set(entry.path, entry.kind);
      let parentPath = entry.path.slice(0, entry.path.lastIndexOf("/"));
      while (parentPath) {
        searchKinds.set(parentPath, "directory");
        parentPath = parentPath.slice(0, parentPath.lastIndexOf("/"));
      }
    }
    entryKindsRef.current = searchKinds;
    model.resetPaths([...searchKinds].map(([path, kind]) => treePath({ path, kind })));
    setTreeRevision((revision) => revision + 1);
  }, [
    model,
    normalizedSearchValue,
    pathSearch.entries,
    pathSearch.isPending,
    pathSearch.searchedQuery,
    searchActive,
  ]);

  useEffect(() => {
    if (!selectedPath || searchActive || entryKindsRef.current.has(selectedPath)) return;
    let cancelled = false;
    void (async () => {
      await loadDirectory("");
      if (cancelled) return;
      const segments = selectedPath.split("/");
      let parentPath = "";
      for (const segment of segments.slice(0, -1)) {
        parentPath = parentPath ? `${parentPath}/${segment}` : segment;
        await loadDirectory(parentPath);
        if (cancelled) return;
        const item = model.getItem(`${parentPath}/`) ?? model.getItem(parentPath);
        if (item && "expand" in item) item.expand();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDirectory, model, searchActive, selectedPath, treeRevision]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    if (entryKindsRef.current.get(selectedPath) !== "file") return;
    const selectedItem = model.getItem(selectedPath);
    if (!selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    selectedItem.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [model, selectedPath, selectedPathRevealId, treeRevision]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const treeHost = panel.querySelector("file-tree-container");
    const dragEventTarget = treeHost?.shadowRoot;
    if (dragEventTarget === null || dragEventTarget === undefined) {
      return;
    }
    const handleDragStart = (event: Event) => {
      if (!(event instanceof DragEvent)) return;
      dragMention.handleDragStart(event);
      setTreeDragActive(dragMention.isDragInProgress());
    };
    const handleDragEnd = () => {
      dragMention.handleDragEnd();
      setTreeDragActive(false);
    };
    const handleDragOver = (event: Event) => {
      if (!(event instanceof DragEvent)) return;
      const target = fileTreeDirectoryDropTarget(event);
      if (
        target === null ||
        resolveMove({ draggedPaths: dragMention.getDraggedPaths(), target }) === null
      ) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    };
    const handleDrop = (event: Event) => {
      if (!(event instanceof DragEvent)) return;
      const target = fileTreeDirectoryDropTarget(event);
      if (target === null) return;
      const draggedPaths = dragMention.getDraggedPaths();
      if (resolveMove({ draggedPaths, target }) === null) return;
      // Pierre owns the drag gesture and visual target. Complete persistence here before the
      // shadow tree can lose its source row to virtualization during a cross-folder drop.
      event.preventDefault();
      event.stopPropagation();
      handleDragEnd();
      completeMoveRef.current({
        draggedPaths,
        target,
        operation: draggedPaths.length > 1 ? "batch" : "move",
      });
    };
    // Native drag events can remain inside Pierre's shadow root, especially once a nested
    // source row is virtualized. Listen at the shadow boundary instead of assuming the events
    // will always compose through to the surrounding panel.
    dragEventTarget.addEventListener("dragstart", handleDragStart, true);
    dragEventTarget.addEventListener("dragover", handleDragOver, true);
    dragEventTarget.addEventListener("drop", handleDrop, true);
    dragEventTarget.addEventListener("dragend", handleDragEnd);
    return () => {
      dragEventTarget.removeEventListener("dragstart", handleDragStart, true);
      dragEventTarget.removeEventListener("dragover", handleDragOver, true);
      dragEventTarget.removeEventListener("drop", handleDrop, true);
      dragEventTarget.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention, resolveMove]);

  const rootDraggedPaths = dragMention.getDraggedPaths();
  const rootDropAvailable =
    treeDragActive &&
    resolveMove({ draggedPaths: rootDraggedPaths, target: PROJECT_ROOT_DROP_TARGET }) !== null;

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      aria-busy={movePending}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton
          isPending={pendingDirectoryCount > 0 || pathSearch.isPending}
          onRefresh={refreshFiles}
        />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={searchValue}
          onValueChange={setSearchValue}
          onClose={() => setSearchValue("")}
        />
        <ShowIgnoredFilesButton
          includeIgnored={includeIgnored}
          onIncludeIgnoredChange={setIncludeIgnored}
        />
      </div>
      {rootDropAvailable ? (
        <div
          className="mx-2 my-1 rounded-md border border-dashed border-primary/50 bg-primary/5 px-2 py-1.5 text-center text-[11px] text-muted-foreground"
          data-file-tree-root-drop
          onDragOver={(event) => {
            if (
              resolveMove({
                draggedPaths: dragMention.getDraggedPaths(),
                target: PROJECT_ROOT_DROP_TARGET,
              }) !== null
            ) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const draggedPaths = dragMention.getDraggedPaths();
            dragMention.handleDragEnd();
            setTreeDragActive(false);
            completeMoveRef.current({
              draggedPaths,
              target: PROJECT_ROOT_DROP_TARGET,
              operation: draggedPaths.length > 1 ? "batch" : "move",
            });
          }}
        >
          Move to project root
        </div>
      ) : null}
      {rootError || (searchActive && pathSearch.error) ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">
          {rootError ?? pathSearch.error}
        </div>
      ) : (
        <>
          {searchActive && pathSearch.truncated ? (
            <div className="px-3 py-1 text-[11px] text-muted-foreground">
              Showing the first {FILE_TREE_SEARCH_LIMIT} matches
            </div>
          ) : null}
          <FileTree
            model={model}
            aria-label={`${projectName} files`}
            className="min-h-0 flex-1 overflow-hidden"
            style={{
              colorScheme: resolvedTheme,
              ["--trees-fg-override" as string]: "var(--foreground)",
            }}
          />
        </>
      )}
    </div>
  );
}
