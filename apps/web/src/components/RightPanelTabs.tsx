import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ContextMenuItem, PreviewSessionSnapshot, PullRequestState } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  Bot,
  FileDiff,
  Files,
  GitGraph,
  GitPullRequest,
  Globe2,
  GripVertical,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { filterPanelChatPickerItems, PANEL_CHAT_PICKER_RESULT_LIMIT } from "~/panelChats";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import {
  resolvePanelChatOpenAnnouncementThreadId,
  resolveFocusTargetAfterRemoteSurfaceRemoval,
  resolveFocusedRightPanelSurfaceId,
  resolveRightPanelTabKeyAction,
  RIGHT_PANEL_ADD_MENU_SURFACE_ORDER,
  RIGHT_PANEL_EMPTY_SURFACE_ORDER,
  shouldClearRightPanelFocusOwner,
  type StandardRightPanelSurfaceKind,
} from "./RightPanelTabs.logic";
import { writeComposerMentionDragPayload } from "./chat/composerMentionDrag";
import { composerMentionFromRightPanelSurface } from "./rightPanelTabDrag";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onReorder: (surfaceId: string, overSurfaceId: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => Promise<boolean>;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => Promise<boolean>;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => Promise<boolean>;
  onCloseAllSurfaces: () => Promise<boolean>;
  onFocusOwner: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddHistory: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  onAddChat: () => void;
  onOpenChat: (threadId: string) => void;
  onRenameChat: (threadId: string, title: string) => void;
  onRegenerateChatTitle: (threadId: string) => void;
  onDeleteChat: (threadId: string) => Promise<boolean>;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  historyAvailable: boolean;
  historyDisabledReason: string;
  filesAvailable: boolean;
  chatAvailable: boolean;
  chatTitlesById: ReadonlyMap<string, string>;
  panelChats: ReadonlyArray<PanelChatTabMetadata>;
  chatOpenAnnouncement: PanelChatOpenAnnouncement | null;
  onChatOpenAnnouncementHandled: (requestId: number) => void;
  chatTitleRegenerationAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>>;
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  liveAgentCount: number;
  children: ReactNode;
}

type SortableRightPanelTabBag = Pick<
  ReturnType<typeof useSortable>,
  | "attributes"
  | "listeners"
  | "setActivatorNodeRef"
  | "setNodeRef"
  | "transform"
  | "transition"
  | "isDragging"
>;

function SortableRightPanelTab(props: {
  readonly id: string;
  readonly children: (bag: SortableRightPanelTabBag) => ReactNode;
}) {
  return props.children(useSortable({ id: props.id }));
}

export interface PanelChatTabMetadata {
  readonly threadId: string;
  readonly title: string;
  readonly running: boolean;
  readonly needsAttention: boolean;
  readonly unread: boolean;
}

export interface PanelChatOpenAnnouncement {
  readonly requestId: number;
  readonly threadId: string;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the T3 Code desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  agents: "Agents are only available from a thread.",
} as const;

interface StandardSurfaceActionsInput {
  readonly onAddBrowser: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddFiles: () => void;
  readonly onAddDiff: () => void;
  readonly onAddPullRequest: () => void;
  readonly onAddHistory: () => void;
  readonly onAddAgents: () => void;
  readonly browserAvailable: boolean;
  readonly terminalAvailable: boolean;
  readonly filesAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly pullRequestAvailable: boolean;
  readonly historyAvailable: boolean;
  readonly historyDisabledReason: string;
  readonly agentsAvailable: boolean;
  readonly liveAgentCount: number;
}

export function buildStandardSurfaceActions(input: StandardSurfaceActionsInput) {
  return {
    browser: {
      label: "Browser",
      description: "Open a local app or URL.",
      icon: Globe2,
      available: input.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: input.onAddBrowser,
      badgeCount: 0,
    },
    terminal: {
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      available: input.terminalAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.terminal,
      onClick: input.onAddTerminal,
      badgeCount: 0,
    },
    files: {
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      available: input.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: input.onAddFiles,
      badgeCount: 0,
    },
    diff: {
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      available: input.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: input.onAddDiff,
      badgeCount: 0,
    },
    "pull-request": {
      label: "Pull request",
      description: "Open the pull request for this thread's branch.",
      icon: GitPullRequest,
      available: input.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: input.onAddPullRequest,
      badgeCount: 0,
    },
    history: {
      label: "History",
      description: "Browse the repository commit graph.",
      icon: GitGraph,
      available: input.historyAvailable,
      disabledReason: input.historyDisabledReason,
      onClick: input.onAddHistory,
      badgeCount: 0,
    },
    agents: {
      label: "Agents",
      description: "Watch subagents and workflows run.",
      icon: Bot,
      available: input.agentsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.agents,
      onClick: input.onAddAgents,
      badgeCount: input.liveAgentCount,
    },
  } satisfies Record<
    StandardRightPanelSurfaceKind,
    {
      readonly label: string;
      readonly description: string;
      readonly icon: typeof Globe2;
      readonly available: boolean;
      readonly disabledReason: string | null;
      readonly onClick: () => void;
      readonly badgeCount: number;
    }
  >;
}

type TabContextMenuAction =
  | "copy-path"
  | "rename-chat"
  | "regenerate-chat-title"
  | "delete-chat"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

/** One-line unavailability hints for the empty-state cards. */
const SURFACE_UNAVAILABLE_HINTS = {
  browser: "Only available in the desktop app.",
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  "pull-request": "No pull request on this branch yet.",
  history: "Available for Git repositories.",
  agents: "Available from a thread.",
} satisfies Record<StandardRightPanelSurfaceKind, string>;

const SURFACE_SHORTCUTS = {
  browser: "B",
  terminal: "T",
  files: "F",
  diff: "D",
  "pull-request": "P",
  history: "H",
  agents: "A",
} satisfies Record<StandardRightPanelSurfaceKind, string>;

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
    >
      {props.children}
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

/**
 * Card launcher shown when the right panel has no surfaces. Keyboard-first
 * without palette chrome: a surface's letter opens it directly from anywhere
 * outside a typing context, and arrows plus Enter work while the launcher is
 * focused. The highlight only appears on hover or arrow use. Unavailable
 * surfaces stay visible with a one-line reason.
 */
function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddHistory: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  onAddChat: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  historyAvailable: boolean;
  historyDisabledReason: string;
  filesAvailable: boolean;
  chatAvailable: boolean;
  panelChats: ReadonlyArray<PanelChatTabMetadata>;
  onOpenChat: (threadId: string) => void;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
}) {
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const visiblePanelChats = useMemo(
    () => filterPanelChatPickerItems(props.panelChats, chatSearchQuery),
    [chatSearchQuery, props.panelChats],
  );
  const standardActions = buildStandardSurfaceActions(props);
  // -1 means no highlight: it only appears on hover or arrow use.
  const [highlight, setHighlight] = useState(-1);
  const actions = [
    ...RIGHT_PANEL_EMPTY_SURFACE_ORDER.map((kind) => ({
      ...standardActions[kind],
      shortcut: SURFACE_SHORTCUTS[kind],
      disabledReason: SURFACE_UNAVAILABLE_HINTS[kind],
    })),
    ...(props.chatAvailable
      ? [
          {
            label: "New Chat",
            description: "Start a focused conversation in this workspace.",
            icon: MessageSquare,
            shortcut: "C",
            available: true,
            disabledReason: null,
            onClick: props.onAddChat,
            badgeCount: 0,
          },
        ]
      : []),
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  // Letter shortcuts work while the launcher is visible, not only while it
  // is focused; focus moves around too easily (stray clicks) to carry them.
  // Capture phase so app-level key handlers cannot swallow the event first;
  // typing contexts and already-handled events are left alone.
  const shortcutActionsRef = useRef(availableActions);
  useEffect(() => {
    shortcutActionsRef.current = availableActions;
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest("input, textarea, select")) return;
        // An empty contenteditable (the chat composer at rest) does not
        // count as typing; letters only become text once a draft exists.
        const editable = target.isContentEditable ? target : target.closest("[contenteditable]");
        if (editable && (editable.textContent ?? "").trim().length > 0) return;
      }
      const action = shortcutActionsRef.current.find(
        (candidate) => candidate.shortcut.toLowerCase() === event.key.toLowerCase(),
      );
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action.onClick();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      // A focused card button owns its own activation; only open from the
      // highlight when the container itself has focus.
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  // Stable identity so React only runs this callback ref on mount/unmount;
  // an inline arrow would re-attach and re-focus on every render.
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction, iconClassName = "size-4") => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
        {action.badgeCount > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
          >
            {action.badgeCount}
          </span>
        ) : null}
      </span>
    );
  };

  const cardShellClass =
    "rounded-lg border border-border/80 bg-card dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5";
  const highlightedCardClass = "bg-accent/60 dark:inset-ring-white/20";

  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none",
        // The panel topbar sits above this container; matching bottom padding
        // keeps the cards centered against the full panel, not the leftover.
        "pb-[calc(var(--workspace-topbar-height)+--spacing(6))]",
      )}
    >
      <div className="relative w-full max-w-lg">
        <div className="absolute inset-x-0 bottom-full mb-5 text-center">
          <h3 className="font-medium text-foreground text-sm">Open a surface</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) =>
            action.available ? (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
                className={cn(
                  "relative flex w-full cursor-pointer flex-col items-start p-4 text-left transition hover:border-border hover:bg-accent/60",
                  cardShellClass,
                  isHighlighted(action) && highlightedCardClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.description}
                </span>
              </button>
            ) : (
              <div
                key={action.label}
                className={cn(
                  "relative flex w-full flex-col items-start p-4 opacity-40",
                  cardShellClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.disabledReason}
                </span>
              </div>
            ),
          )}
        </div>
        {props.chatAvailable && props.panelChats.length > 0 ? (
          <div className="mt-5">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Open a panel chat</p>
            <label className="relative mb-2 block">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={chatSearchQuery}
                onChange={(event) => setChatSearchQuery(event.currentTarget.value)}
                placeholder="Search chats"
                aria-label="Search panel chats"
                className="h-8 w-full rounded-md border border-border bg-background pr-3 pl-8 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {visiblePanelChats.map((chat) => (
                <button
                  key={chat.threadId}
                  type="button"
                  onClick={() => props.onOpenChat(chat.threadId)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                </button>
              ))}
              {visiblePanelChats.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No matching chats.</p>
              ) : null}
            </div>
            {chatSearchQuery.length === 0 &&
            props.panelChats.length > PANEL_CHAT_PICKER_RESULT_LIMIT ? (
              <p className="mt-1 px-3 text-[11px] text-muted-foreground">
                Search to find older chats.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
  chatTitlesById: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "history":
      return "History";
    case "git-commit":
      return surface.sha.slice(0, 7);
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "pull-request":
      return `#${surface.number}`;
    case "agents":
      return "Agents";
    case "chat":
      return chatTitlesById.get(surface.threadId) ?? "Chat";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function SurfaceIcon({
  surface,
  sessions,
  desktopByTabId,
  theme,
  pullRequestStatuses,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  theme: "light" | "dark";
  pullRequestStatuses: Readonly<Record<string, PullRequestTabStatus>> | undefined;
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
      const capturedUrl =
        favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
      return <PreviewFavicon capturedUrl={capturedUrl} url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "history":
      return <GitGraph className="size-3 shrink-0" />;
    case "git-commit":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request": {
      const status = pullRequestStatuses?.[surface.id] ?? null;
      const toneClassName =
        status?.state === "merged"
          ? "text-violet-600 dark:text-violet-300/90"
          : status?.state === "closed"
            ? "text-red-600 dark:text-red-300/90"
            : status?.isDraft
              ? "text-zinc-500 dark:text-zinc-400/80"
              : status?.state === "open"
                ? "text-emerald-600 dark:text-emerald-300/90"
                : "text-muted-foreground";
      return <GitPullRequest className={cn("size-3 shrink-0", toneClassName)} />;
    }
    case "agents":
      return <Bot className="size-3 shrink-0" />;
    case "chat":
      return <MessageSquare className="size-3 shrink-0" />;
  }
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renamingChatTitle, setRenamingChatTitle] = useState("");
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const focusedSurfaceIdRef = useRef<string | null>(null);
  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const previousSurfaceIdsRef = useRef(
    new Set<string>(props.surfaces.map((surface) => surface.id)),
  );
  const panelChatById = useMemo(
    () => new Map(props.panelChats.map((chat) => [chat.threadId, chat] as const)),
    [props.panelChats],
  );
  const openedChatIds = useMemo(
    () =>
      new Set<string>(
        props.surfaces.flatMap((surface) => (surface.kind === "chat" ? [surface.threadId] : [])),
      ),
    [props.surfaces],
  );
  const closedPanelChats = useMemo(
    () => props.panelChats.filter((chat) => !openedChatIds.has(chat.threadId)),
    [openedChatIds, props.panelChats],
  );
  const visibleClosedPanelChats = useMemo(
    () => filterPanelChatPickerItems(closedPanelChats, chatSearchQuery),
    [chatSearchQuery, closedPanelChats],
  );
  const standardActions = buildStandardSurfaceActions(props);
  const focusTab = useCallback((surfaceId: string) => {
    window.requestAnimationFrame(() => tabButtonRefs.current.get(surfaceId)?.focus());
  }, []);
  const beginChatRename = useCallback(
    (threadId: string) => {
      const chat = panelChatById.get(threadId);
      if (!chat) return;
      setRenamingChatId(threadId);
      setRenamingChatTitle(chat.title);
    },
    [panelChatById],
  );
  const commitChatRename = useCallback(() => {
    if (!renamingChatId) return;
    const renamedSurfaceId = `chat:${renamingChatId}`;
    const trimmed = renamingChatTitle.trim();
    const originalTitle = panelChatById.get(renamingChatId)?.title;
    setRenamingChatId(null);
    focusTab(renamedSurfaceId);
    if (!trimmed || trimmed === originalTitle) return;
    props.onRenameChat(renamingChatId, trimmed);
    setAnnouncement(`Panel chat renamed to ${trimmed}.`);
  }, [focusTab, panelChatById, props, renamingChatId, renamingChatTitle]);
  const cancelChatRename = useCallback(() => {
    if (!renamingChatId) return;
    const renamedSurfaceId = `chat:${renamingChatId}`;
    setRenamingChatId(null);
    focusTab(renamedSurfaceId);
  }, [focusTab, renamingChatId]);

  const restoreFocusAfterSurfaceRemoval = useCallback(
    (surface: RightPanelSurface) => {
      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      const focusTarget =
        props.surfaces[surfaceIndex + 1] ?? props.surfaces[surfaceIndex - 1] ?? null;
      if (focusTarget) focusTab(focusTarget.id);
      else window.requestAnimationFrame(props.onFocusOwner);
    },
    [focusTab, props],
  );
  const closeSurfaceAndRestoreFocus = useCallback(
    async (surface: RightPanelSurface) => {
      const closed = await props.onCloseSurface(surface);
      if (closed) restoreFocusAfterSurfaceRemoval(surface);
    },
    [props, restoreFocusAfterSurfaceRemoval],
  );
  const deleteChatAndRestoreFocus = useCallback(
    async (surface: Extract<RightPanelSurface, { kind: "chat" }>) => {
      const shouldRestoreFocus =
        focusedSurfaceIdRef.current === surface.id || props.activeSurfaceId === surface.id;
      if (shouldRestoreFocus) focusedSurfaceIdRef.current = null;
      const deleted = await props.onDeleteChat(surface.threadId);
      if (deleted && shouldRestoreFocus) restoreFocusAfterSurfaceRemoval(surface);
    },
    [props, restoreFocusAfterSurfaceRemoval],
  );
  const closeAllSurfacesAndRestoreFocus = useCallback(async () => {
    const closed = await props.onCloseAllSurfaces();
    if (closed) window.requestAnimationFrame(props.onFocusOwner);
  }, [props]);

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, surface: RightPanelSurface) => {
      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      const action = resolveRightPanelTabKeyAction({
        key: event.key,
        currentIndex: surfaceIndex,
        tabCount: props.surfaces.length,
        chat: surface.kind === "chat",
      });
      if (!action) return;
      event.preventDefault();
      if (action.kind === "rename") {
        if (surface.kind === "chat") beginChatRename(surface.threadId);
        return;
      }
      if (action.kind === "close") {
        void closeSurfaceAndRestoreFocus(surface);
        return;
      }
      const target = props.surfaces[action.index];
      if (!target) return;
      props.onActivate(target);
      focusTab(target.id);
    },
    [beginChatRename, closeSurfaceAndRestoreFocus, focusTab, props],
  );

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      if (surface.kind === "chat") {
        items.push(
          { id: "rename-chat", label: "Rename" },
          {
            id: "regenerate-chat-title",
            label: "Regenerate title",
            disabled: !props.chatTitleRegenerationAvailable,
          },
          { id: "delete-chat", label: "Delete chat" },
        );
      }
      items.push(
        { id: "close", label: surface.kind === "chat" ? "Close and delete" : "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "rename-chat":
          if (surface.kind === "chat") beginChatRename(surface.threadId);
          break;
        case "regenerate-chat-title":
          if (surface.kind === "chat") props.onRegenerateChatTitle(surface.threadId);
          break;
        case "delete-chat":
          if (surface.kind === "chat") await deleteChatAndRestoreFocus(surface);
          break;
        case "close":
          await closeSurfaceAndRestoreFocus(surface);
          break;
        case "close-others":
          await props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          await props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          await closeAllSurfacesAndRestoreFocus();
          break;
        case null:
          break;
      }
    },
    [
      beginChatRename,
      closeAllSurfacesAndRestoreFocus,
      closeSurfaceAndRestoreFocus,
      deleteChatAndRestoreFocus,
      props,
    ],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      void closeSurfaceAndRestoreFocus(surface);
    },
    [closeSurfaceAndRestoreFocus],
  );
  const handleTabDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>, mention: string | null) => {
      if (!writeComposerMentionDragPayload(event.dataTransfer, mention)) {
        event.preventDefault();
      }
    },
    [],
  );
  const handleTabReorderEnd = useCallback(
    (event: DragEndEvent) => {
      const surfaceId = String(event.active.id);
      const overSurfaceId = event.over === null ? null : String(event.over.id);
      if (overSurfaceId === null || surfaceId === overSurfaceId) return;
      props.onReorder(surfaceId, overSurfaceId);
      focusTab(surfaceId);
    },
    [focusTab, props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  useLayoutEffect(() => {
    const previousSurfaceIds = previousSurfaceIdsRef.current;
    const currentSurfaceIds = new Set(props.surfaces.map((surface) => surface.id));
    previousSurfaceIdsRef.current = currentSurfaceIds;
    const focusTarget = resolveFocusTargetAfterRemoteSurfaceRemoval({
      previousSurfaceIds,
      currentSurfaceIds,
      focusedSurfaceId: focusedSurfaceIdRef.current,
      activeSurfaceId: props.activeSurfaceId,
    });
    if (!focusTarget) return;
    focusedSurfaceIdRef.current = null;
    if (focusTarget.kind === "surface") focusTab(focusTarget.surfaceId);
    else window.requestAnimationFrame(props.onFocusOwner);
  }, [focusTab, props.activeSurfaceId, props.onFocusOwner, props.surfaces]);

  useEffect(() => {
    const openAnnouncement = props.chatOpenAnnouncement;
    if (!openAnnouncement) return;
    const openedChatThreadId = resolvePanelChatOpenAnnouncementThreadId({
      requestedThreadId: openAnnouncement.threadId,
      surfaces: props.surfaces,
    });
    props.onChatOpenAnnouncementHandled(openAnnouncement.requestId);
    if (!openedChatThreadId) return;
    setAnnouncement(
      `${props.chatTitlesById.get(openedChatThreadId) ?? "Panel chat"} opened in the right panel.`,
    );
  }, [
    props.chatOpenAnnouncement,
    props.chatTitlesById,
    props.onChatOpenAnnouncementHandled,
    props.surfaces,
  ]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      onFocusCapture={(event) => {
        const focusOwner = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-right-panel-focus-surface-id]",
        );
        focusedSurfaceIdRef.current = resolveFocusedRightPanelSurfaceId(
          focusOwner?.dataset.rightPanelFocusSurfaceId,
        );
      }}
      onBlurCapture={(event) => {
        const relatedTargetRemainsInside =
          event.relatedTarget instanceof Node
            ? event.currentTarget.contains(event.relatedTarget)
            : null;
        if (shouldClearRightPanelFocusOwner(relatedTargetRemainsInside)) {
          focusedSurfaceIdRef.current = null;
        }
      }}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
    >
      <div
        className={cn(
          "workspace-topbar gap-1 pl-2",
          props.mode !== "inline" && "[--workspace-topbar-height:--spacing(11)]",
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
          data-right-panel-tab-list
        >
          <DndContext
            sensors={reorderSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
            onDragEnd={handleTabReorderEnd}
          >
            <div
              className="flex h-full w-max min-w-full items-center gap-1"
              role="tablist"
              aria-label="Right panel surfaces"
            >
              <SortableContext
                items={props.surfaces.map((surface) => surface.id)}
                strategy={horizontalListSortingStrategy}
              >
                {props.surfaces.map((surface, surfaceIndex) => {
                  const active = surface.id === props.activeSurfaceId;
                  const pending = props.pendingSurfaceIds.has(surface.id);
                  const chat = surface.kind === "chat" ? panelChatById.get(surface.threadId) : null;
                  const title = surfaceTitle(
                    surface,
                    props.previewSessions,
                    props.terminalLabelsById,
                    props.chatTitlesById,
                  );
                  const composerMention = composerMentionFromRightPanelSurface(surface);
                  return (
                    <SortableRightPanelTab key={surface.id} id={surface.id}>
                      {(sortable) => (
                        <div
                          ref={(element) => {
                            sortable.setNodeRef(element);
                            sortable.setActivatorNodeRef(element);
                          }}
                          style={{
                            transform: CSS.Translate.toString(sortable.transform),
                            transition: sortable.transition,
                          }}
                          data-right-panel-focus-surface-id={surface.id}
                          role="presentation"
                          data-active-tab={active}
                          onMouseDown={handleTabMouseDown}
                          onPointerDown={(event) => sortable.listeners?.onPointerDown?.(event)}
                          onAuxClick={(event) => handleTabAuxClick(event, surface)}
                          onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                          className={cn(
                            "group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                            composerMention === null && "cursor-grab active:cursor-grabbing",
                            active
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                            sortable.isDragging && "z-10 opacity-80",
                          )}
                        >
                          <button
                            type="button"
                            className="cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                            aria-label={
                              surface.kind === "chat"
                                ? `Close and delete ${title}`
                                : `Close ${title}`
                            }
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => void closeSurfaceAndRestoreFocus(surface)}
                          >
                            <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
                              <SurfaceIcon
                                surface={surface}
                                sessions={props.previewSessions}
                                desktopByTabId={props.desktopByTabId}
                                theme={resolvedTheme}
                                pullRequestStatuses={props.pullRequestStatuses}
                              />
                              {pending ? (
                                <span
                                  className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                                  aria-hidden
                                />
                              ) : null}
                            </span>
                            <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
                          </button>
                          {surface.kind === "chat" && renamingChatId === surface.threadId ? (
                            <input
                              autoFocus
                              aria-label="Rename panel chat"
                              value={renamingChatTitle}
                              onChange={(event) => setRenamingChatTitle(event.target.value)}
                              onBlur={commitChatRename}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitChatRename();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelChatRename();
                                }
                              }}
                              className="h-5 min-w-16 max-w-28 rounded border border-border bg-background px-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                            />
                          ) : (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    {...(composerMention === null ? sortable.attributes : {})}
                                    ref={(element) => {
                                      if (element) tabButtonRefs.current.set(surface.id, element);
                                      else tabButtonRefs.current.delete(surface.id);
                                    }}
                                    id={`right-panel-tab-${encodeURIComponent(surface.id)}`}
                                    role="tab"
                                    aria-selected={active}
                                    aria-controls="right-panel-active-surface"
                                    tabIndex={active ? 0 : -1}
                                    className={cn(
                                      "flex min-w-0 items-center",
                                      composerMention === null
                                        ? "cursor-grab active:cursor-grabbing"
                                        : "cursor-pointer",
                                    )}
                                    draggable={composerMention !== null}
                                    onPointerDown={
                                      composerMention === null
                                        ? undefined
                                        : (event) => event.stopPropagation()
                                    }
                                    onDragStart={(event) =>
                                      handleTabDragStart(event, composerMention)
                                    }
                                    onClick={() => props.onActivate(surface)}
                                    onKeyDown={(event) => {
                                      handleTabKeyDown(event, surface);
                                      if (
                                        composerMention === null &&
                                        !event.defaultPrevented &&
                                        event.key === " "
                                      ) {
                                        sortable.listeners?.onKeyDown?.(event);
                                      }
                                    }}
                                    onDoubleClick={() => {
                                      if (surface.kind === "chat")
                                        beginChatRename(surface.threadId);
                                    }}
                                  >
                                    <span className="truncate">{title}</span>
                                  </button>
                                }
                              />
                              <TooltipPopup>{title}</TooltipPopup>
                            </Tooltip>
                          )}
                          {composerMention !== null ? (
                            <button
                              type="button"
                              {...sortable.attributes}
                              aria-label={`Reorder ${title}`}
                              title="Drag to reorder"
                              onKeyDown={(event) => sortable.listeners?.onKeyDown?.(event)}
                              className="inline-flex size-4 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 outline-none hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 active:cursor-grabbing focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              <GripVertical aria-hidden className="size-3" />
                            </button>
                          ) : null}
                          {chat?.running || chat?.needsAttention || chat?.unread ? (
                            <span
                              className={cn(
                                "ml-1 size-1.5 shrink-0 rounded-full",
                                chat.needsAttention
                                  ? "bg-warning"
                                  : chat.running
                                    ? "bg-info"
                                    : "bg-foreground",
                              )}
                              title={
                                chat.needsAttention
                                  ? "Needs attention"
                                  : chat.running
                                    ? "Running"
                                    : "Unread"
                              }
                              aria-label={
                                chat.needsAttention
                                  ? "Needs attention"
                                  : chat.running
                                    ? "Running"
                                    : "Unread"
                              }
                            />
                          ) : null}
                          {surface.kind === "chat" ? (
                            <Menu>
                              <MenuTrigger
                                className="cursor-pointer inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/tab:opacity-100"
                                aria-label={`Manage ${title}`}
                              >
                                <MoreHorizontal className="size-3" />
                              </MenuTrigger>
                              <MenuPopup
                                align="start"
                                side="bottom"
                                sideOffset={6}
                                className="min-w-44"
                              >
                                <MenuItem onClick={() => beginChatRename(surface.threadId)}>
                                  Rename
                                </MenuItem>
                                <MenuItem
                                  disabled={!props.chatTitleRegenerationAvailable}
                                  onClick={() => props.onRegenerateChatTitle(surface.threadId)}
                                >
                                  Regenerate title
                                </MenuItem>
                                <MenuItem onClick={() => void deleteChatAndRestoreFocus(surface)}>
                                  Delete chat
                                </MenuItem>
                                <MenuSeparator />
                                <MenuItem onClick={() => void closeSurfaceAndRestoreFocus(surface)}>
                                  Close and delete
                                </MenuItem>
                                <MenuItem
                                  disabled={props.surfaces.length <= 1}
                                  onClick={() => void props.onCloseOtherSurfaces(surface)}
                                >
                                  Close others
                                </MenuItem>
                                <MenuItem
                                  disabled={surfaceIndex >= props.surfaces.length - 1}
                                  onClick={() => void props.onCloseSurfacesToRight(surface)}
                                >
                                  Close to the right
                                </MenuItem>
                                <MenuItem onClick={() => void closeAllSurfacesAndRestoreFocus()}>
                                  Close all
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          ) : null}
                        </div>
                      )}
                    </SortableRightPanelTab>
                  );
                })}
              </SortableContext>
              {props.surfaces.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    className="cursor-pointer relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Add panel surface"
                  >
                    <Plus className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                    {RIGHT_PANEL_ADD_MENU_SURFACE_ORDER.map((kind) => {
                      const action = standardActions[kind];
                      const Icon = action.icon;
                      return (
                        <SurfaceMenuItem
                          key={kind}
                          available={action.available}
                          {...(action.disabledReason === null
                            ? {}
                            : { disabledReason: action.disabledReason })}
                          onClick={action.onClick}
                        >
                          <Icon />
                          {action.label}
                        </SurfaceMenuItem>
                      );
                    })}
                    {props.chatAvailable ? (
                      <>
                        <SurfaceMenuItem available onClick={props.onAddChat}>
                          <MessageSquare />
                          New Chat
                        </SurfaceMenuItem>
                        {closedPanelChats.length > 0 ? (
                          <MenuSub>
                            <MenuSubTrigger>
                              <MessageSquare />
                              Open chat
                            </MenuSubTrigger>
                            <MenuSubPopup className="min-w-64">
                              <div
                                className="relative m-1"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <Search
                                  aria-hidden
                                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                                />
                                <input
                                  type="search"
                                  value={chatSearchQuery}
                                  onChange={(event) =>
                                    setChatSearchQuery(event.currentTarget.value)
                                  }
                                  onKeyDown={(event) => event.stopPropagation()}
                                  placeholder="Search chats"
                                  aria-label="Search panel chats"
                                  className="h-8 w-full rounded-md border border-border bg-background pr-2 pl-7 text-xs outline-none focus:ring-1 focus:ring-ring"
                                />
                              </div>
                              <div className="max-h-64 overflow-y-auto">
                                {visibleClosedPanelChats.map((chat) => (
                                  <MenuItem
                                    key={chat.threadId}
                                    onClick={() => props.onOpenChat(chat.threadId)}
                                  >
                                    <span className="truncate">{chat.title}</span>
                                  </MenuItem>
                                ))}
                              </div>
                              {visibleClosedPanelChats.length === 0 ? (
                                <p className="px-3 py-2 text-xs text-muted-foreground">
                                  No matching chats.
                                </p>
                              ) : null}
                              {chatSearchQuery.length === 0 &&
                              closedPanelChats.length > PANEL_CHAT_PICKER_RESULT_LIMIT ? (
                                <p className="px-3 py-1 text-[11px] text-muted-foreground">
                                  Search to find older chats.
                                </p>
                              ) : null}
                            </MenuSubPopup>
                          </MenuSub>
                        ) : null}
                      </>
                    ) : null}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          </DndContext>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div
        id="right-panel-active-surface"
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
        data-right-panel-focus-surface-id={props.activeSurfaceId ?? undefined}
        role={props.activeSurfaceId === null ? undefined : "tabpanel"}
        aria-labelledby={
          props.activeSurfaceId === null
            ? undefined
            : `right-panel-tab-${encodeURIComponent(props.activeSurfaceId)}`
        }
      >
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddHistory={props.onAddHistory}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddAgents={props.onAddAgents}
            onAddChat={props.onAddChat}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            historyAvailable={props.historyAvailable}
            historyDisabledReason={props.historyDisabledReason}
            filesAvailable={props.filesAvailable}
            chatAvailable={props.chatAvailable}
            panelChats={closedPanelChats}
            onOpenChat={props.onOpenChat}
            pullRequestAvailable={props.pullRequestAvailable}
            agentsAvailable={props.agentsAvailable}
            liveAgentCount={props.liveAgentCount}
          />
        ) : (
          props.children
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </PreviewPanelShell>
  );
}
