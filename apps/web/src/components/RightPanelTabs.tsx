import type { ContextMenuItem, PreviewSessionSnapshot } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  Bot,
  FileDiff,
  Files,
  Globe2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddAgents: () => void;
  onAddChat: () => void;
  onOpenChat: (threadId: string) => void;
  onRenameChat: (threadId: string, title: string) => void;
  onRegenerateChatTitle: (threadId: string) => void;
  onDeleteChat: (threadId: string) => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  chatAvailable: boolean;
  chatTitlesById: ReadonlyMap<string, string>;
  panelChats: ReadonlyArray<PanelChatTabMetadata>;
  chatTitleRegenerationAvailable: boolean;
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  liveAgentCount: number;
  children: ReactNode;
}

export interface PanelChatTabMetadata {
  readonly threadId: string;
  readonly title: string;
  readonly running: boolean;
  readonly needsAttention: boolean;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the T3 Code desktop app.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
} as const;

type TabContextMenuAction =
  | "copy-path"
  | "rename-chat"
  | "regenerate-chat-title"
  | "delete-chat"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

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

function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddAgents: () => void;
  onAddChat: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  chatAvailable: boolean;
  panelChats: ReadonlyArray<PanelChatTabMetadata>;
  onOpenChat: (threadId: string) => void;
  liveAgentCount: number;
}) {
  const actions = [
    ...(props.chatAvailable
      ? [
          {
            label: "Chat",
            description: "Start a focused conversation in this workspace.",
            icon: MessageSquare,
            available: true,
            disabledReason: null,
            onClick: props.onAddChat,
            badgeCount: 0,
          },
        ]
      : []),
    {
      label: "Browser",
      description: "Open a local app or URL.",
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
      badgeCount: 0,
    },
    {
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      available: true,
      disabledReason: null,
      onClick: props.onAddTerminal,
      badgeCount: 0,
    },
    {
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
      badgeCount: 0,
    },
    {
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
      badgeCount: 0,
    },
    {
      label: "Agents",
      description: "Watch subagents and workflows run.",
      icon: Bot,
      available: true,
      disabledReason: null,
      onClick: props.onAddAgents,
      badgeCount: props.liveAgentCount,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a surface</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <span className="relative mb-3 inline-flex">
                  <Icon className="size-5" />
                  {action.badgeCount > 0 ? (
                    <span
                      aria-hidden
                      className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                    >
                      {action.badgeCount}
                    </span>
                  ) : null}
                </span>
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="cursor-pointer flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  {content}
                </button>
              );
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left opacity-40 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                aria-disabled="true"
              >
                {content}
              </button>
            );
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason ?? "This surface is unavailable."}
                trigger={disabledCard}
              />
            );
          })}
        </div>
        {props.chatAvailable && props.panelChats.length > 0 ? (
          <div className="mt-5">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Open a panel chat</p>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {props.panelChats.map((chat) => (
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
            </div>
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
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
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

function PreviewFavicon({ url }: { url: string | null }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) return <Globe2 className="size-3 shrink-0" />;
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3 shrink-0 rounded-sm"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

function SurfaceIcon({
  surface,
  sessions,
  theme,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "diff":
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
  const [announcement, setAnnouncement] = useState("");
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
  const previousChatSurfaceIdsRef = useRef(openedChatIds);
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

  const closeSurfaceAndRestoreFocus = useCallback(
    (surface: RightPanelSurface) => {
      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      const focusTarget =
        props.surfaces[surfaceIndex + 1] ?? props.surfaces[surfaceIndex - 1] ?? null;
      props.onCloseSurface(surface);
      if (focusTarget) focusTab(focusTarget.id);
    },
    [focusTab, props],
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, surface: RightPanelSurface) => {
      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      if (event.key === "F2" && surface.kind === "chat") {
        event.preventDefault();
        beginChatRename(surface.threadId);
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        closeSurfaceAndRestoreFocus(surface);
        return;
      }

      let target: RightPanelSurface | undefined;
      if (event.key === "ArrowLeft") {
        target = props.surfaces[(surfaceIndex - 1 + props.surfaces.length) % props.surfaces.length];
      } else if (event.key === "ArrowRight") {
        target = props.surfaces[(surfaceIndex + 1) % props.surfaces.length];
      } else if (event.key === "Home") {
        target = props.surfaces[0];
      } else if (event.key === "End") {
        target = props.surfaces.at(-1);
      }
      if (!target) return;
      event.preventDefault();
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
        { id: "close", label: "Close" },
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
          if (surface.kind === "chat") props.onDeleteChat(surface.threadId);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [beginChatRename, props],
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
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  useEffect(() => {
    const previousIds = previousChatSurfaceIdsRef.current;
    const openedChat = props.surfaces.find(
      (surface) => surface.kind === "chat" && !previousIds.has(surface.threadId),
    );
    previousChatSurfaceIdsRef.current = openedChatIds;
    if (!openedChat || openedChat.kind !== "chat") return;
    setAnnouncement(
      `${props.chatTitlesById.get(openedChat.threadId) ?? "Panel chat"} opened in the right panel.`,
    );
  }, [openedChatIds, props.chatTitlesById, props.surfaces]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          "workspace-topbar gap-1 pl-2",
          props.mode !== "inline" && "[--workspace-topbar-height:--spacing(11)]",
          props.mode === "inline" ? "pr-28" : "pr-3",
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
          <div
            className="flex h-full w-max min-w-full items-center gap-1"
            role="tablist"
            aria-label="Right panel surfaces"
          >
            {props.surfaces.map((surface) => {
              const active = surface.id === props.activeSurfaceId;
              const pending = props.pendingSurfaceIds.has(surface.id);
              const chat = surface.kind === "chat" ? panelChatById.get(surface.threadId) : null;
              const title = surfaceTitle(
                surface,
                props.previewSessions,
                props.terminalLabelsById,
                props.chatTitlesById,
              );
              return (
                <div
                  key={surface.id}
                  role="presentation"
                  data-active-tab={active}
                  onMouseDown={handleTabMouseDown}
                  onAuxClick={(event) => handleTabAuxClick(event, surface)}
                  onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                  className={cn(
                    "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    className="cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                    aria-label={`Close ${title}`}
                    onClick={() => closeSurfaceAndRestoreFocus(surface)}
                  >
                    <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
                      <SurfaceIcon
                        surface={surface}
                        sessions={props.previewSessions}
                        theme={resolvedTheme}
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
                            ref={(element) => {
                              if (element) tabButtonRefs.current.set(surface.id, element);
                              else tabButtonRefs.current.delete(surface.id);
                            }}
                            id={`right-panel-tab-${encodeURIComponent(surface.id)}`}
                            role="tab"
                            aria-selected={active}
                            aria-controls="right-panel-active-surface"
                            tabIndex={active ? 0 : -1}
                            className="cursor-pointer flex min-w-0 items-center"
                            onClick={() => props.onActivate(surface)}
                            onKeyDown={(event) => handleTabKeyDown(event, surface)}
                            onDoubleClick={() => {
                              if (surface.kind === "chat") beginChatRename(surface.threadId);
                            }}
                          >
                            <span className="truncate">{title}</span>
                          </button>
                        }
                      />
                      <TooltipPopup>{title}</TooltipPopup>
                    </Tooltip>
                  )}
                  {chat?.running || chat?.needsAttention ? (
                    <span
                      className={cn(
                        "ml-1 size-1.5 shrink-0 rounded-full",
                        chat.needsAttention ? "bg-warning" : "bg-info",
                      )}
                      title={chat.needsAttention ? "Needs attention" : "Running"}
                      aria-label={chat.needsAttention ? "Needs attention" : "Running"}
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
                      <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                        <MenuItem onClick={() => beginChatRename(surface.threadId)}>
                          Rename
                        </MenuItem>
                        <MenuItem
                          disabled={!props.chatTitleRegenerationAvailable}
                          onClick={() => props.onRegenerateChatTitle(surface.threadId)}
                        >
                          Regenerate title
                        </MenuItem>
                        <MenuItem onClick={() => props.onDeleteChat(surface.threadId)}>
                          Delete chat
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </div>
              );
            })}
            {props.surfaces.length > 0 ? (
              <Menu>
                <MenuTrigger
                  className="cursor-pointer relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Add panel surface"
                >
                  <Plus className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                  <SurfaceMenuItem
                    available={props.browserAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.browser}
                    onClick={props.onAddBrowser}
                  >
                    <Globe2 />
                    Browser
                  </SurfaceMenuItem>
                  <SurfaceMenuItem available onClick={props.onAddTerminal}>
                    <TerminalSquare />
                    Terminal
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.filesAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.files}
                    onClick={props.onAddFiles}
                  >
                    <Files />
                    Files
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.diffAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.diff}
                    onClick={props.onAddDiff}
                  >
                    <FileDiff />
                    Diff
                  </SurfaceMenuItem>
                  <SurfaceMenuItem available onClick={props.onAddAgents}>
                    <Bot />
                    Agents
                  </SurfaceMenuItem>
                  {props.chatAvailable ? (
                    <>
                      <SurfaceMenuItem available onClick={props.onAddChat}>
                        <MessageSquare />
                        New chat
                      </SurfaceMenuItem>
                      {closedPanelChats.length > 0 ? (
                        <MenuSub>
                          <MenuSubTrigger>
                            <MessageSquare />
                            Open chat
                          </MenuSubTrigger>
                          <MenuSubPopup className="min-w-56">
                            {closedPanelChats.map((chat) => (
                              <MenuItem
                                key={chat.threadId}
                                onClick={() => props.onOpenChat(chat.threadId)}
                              >
                                <span className="truncate">{chat.title}</span>
                              </MenuItem>
                            ))}
                          </MenuSubPopup>
                        </MenuSub>
                      ) : null}
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div
        id="right-panel-active-surface"
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
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
            onAddFiles={props.onAddFiles}
            onAddAgents={props.onAddAgents}
            onAddChat={props.onAddChat}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            chatAvailable={props.chatAvailable}
            panelChats={closedPanelChats}
            onOpenChat={props.onOpenChat}
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
