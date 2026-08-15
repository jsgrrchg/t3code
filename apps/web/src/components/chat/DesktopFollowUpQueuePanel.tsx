import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckIcon,
  CornerDownRightIcon,
  GripVerticalIcon,
  ImageIcon,
  ListOrderedIcon,
  PauseIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type {
  DesktopQueuedFollowUp,
  DesktopQueuedMessageFollowUp,
} from "../../desktopFollowUpQueueStore";
import {
  type DraftId,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { cn, isMacPlatform } from "../../lib/utils";
import {
  isPrimaryShortcutModifierOnly,
  useShortcutModifierState,
} from "../../shortcutModifierState";
import { Button } from "../ui/button";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function promptPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim() || "Image attachment";
}

function queuedEntryLabel(entry: DesktopQueuedFollowUp): string {
  if (entry.kind === "message") return promptPreview(entry.text);
  if (entry.action.type === "compact") return "/compact";

  switch (entry.action.target.type) {
    case "uncommittedChanges":
      return "/review";
    case "baseBranch":
      return `/review-branch ${entry.action.target.branch}`;
    case "commit":
      return `/review-commit ${entry.action.target.sha}`;
  }
}

function resizeQueuedMessageEditor(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 80)}px`;
}

type SortableQueueRowBag = Pick<
  ReturnType<typeof useSortable>,
  | "attributes"
  | "listeners"
  | "setActivatorNodeRef"
  | "setNodeRef"
  | "transform"
  | "transition"
  | "isDragging"
>;

function SortableQueueRow(props: {
  readonly id: string;
  readonly disabled: boolean;
  readonly children: (bag: SortableQueueRowBag) => ReactNode;
}) {
  return props.children(useSortable({ id: props.id, disabled: props.disabled }));
}

function SteerShortcutBadge(props: { composerDraftTarget: ScopedThreadRef | DraftId }) {
  const modifiers = useShortcutModifierState();
  const composerHasUserContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(props.composerDraftTarget)),
  );
  const platform = navigator.platform;
  if (composerHasUserContent || !isPrimaryShortcutModifierOnly(modifiers, platform)) return null;

  const keys = isMacPlatform(platform) ? ["⌘", "↵"] : ["Ctrl", "Enter"];
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-6 -translate-y-1/2 items-center gap-1.5 rounded-full border border-border/80 bg-background/95 px-1.5 text-[10px] font-medium text-foreground shadow-sm"
    >
      <CornerDownRightIcon className="size-3 text-muted-foreground" />
      Steer
      <KbdGroup className="gap-0.5">
        {keys.map((key) => (
          <Kbd key={key} className="h-4 min-w-4 rounded-sm px-1 text-[9px]">
            {key}
          </Kbd>
        ))}
      </KbdGroup>
    </span>
  );
}

export const DesktopFollowUpQueuePanel = memo(function DesktopFollowUpQueuePanel({
  entries,
  composerDraftTarget,
  dispatchingEntryId,
  editingEntryId,
  steerShortcutEntryId,
  paused,
  onBeginEdit,
  onCancelEdit,
  onRemove,
  onReorder,
  onSaveEdit,
  onSteer,
}: {
  readonly entries: ReadonlyArray<DesktopQueuedFollowUp>;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly dispatchingEntryId: string | null;
  readonly editingEntryId: string | null;
  readonly steerShortcutEntryId: string | null;
  readonly paused: boolean;
  readonly onBeginEdit: (entry: DesktopQueuedMessageFollowUp) => boolean;
  readonly onCancelEdit: (entry: DesktopQueuedMessageFollowUp) => void;
  readonly onRemove: (entry: DesktopQueuedFollowUp) => void;
  readonly onReorder: (entryId: string, overEntryId: string) => void;
  readonly onSaveEdit: (entry: DesktopQueuedMessageFollowUp, text: string) => boolean;
  readonly onSteer: (entry: DesktopQueuedMessageFollowUp) => void;
}) {
  const [editDraft, setEditDraft] = useState<{ readonly entryId: string; text: string } | null>(
    null,
  );
  const activeEditEntryRef = useRef<DesktopQueuedMessageFollowUp | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.over === null || event.active.id === event.over.id) return;
      onReorder(String(event.active.id), String(event.over.id));
    },
    [onReorder],
  );
  const beginEdit = useCallback(
    (entry: DesktopQueuedMessageFollowUp) => {
      if (!onBeginEdit(entry)) return;
      activeEditEntryRef.current = entry;
      setEditDraft({ entryId: entry.id, text: entry.text });
    },
    [onBeginEdit],
  );
  const cancelEdit = useCallback(
    (entry: DesktopQueuedMessageFollowUp) => {
      onCancelEdit(entry);
      activeEditEntryRef.current = null;
      setEditDraft(null);
    },
    [onCancelEdit],
  );
  const saveEdit = useCallback(
    (entry: DesktopQueuedMessageFollowUp) => {
      if (editDraft?.entryId !== entry.id) return;
      if (!editDraft.text.trim() && entry.attachments.length === 0) return;
      if (onSaveEdit(entry, editDraft.text)) {
        activeEditEntryRef.current = null;
        setEditDraft(null);
      }
    },
    [editDraft, onSaveEdit],
  );
  useEffect(
    () => () => {
      const editingEntry = activeEditEntryRef.current;
      if (editingEntry) onCancelEdit(editingEntry);
    },
    [onCancelEdit],
  );

  if (entries.length === 0) return null;

  const reorderingDisabled =
    editingEntryId !== null ||
    (dispatchingEntryId !== null && entries.some((entry) => entry.id === dispatchingEntryId));

  return (
    <div className="surface-glass relative mt-6 rounded-xl border border-border/45 px-2 pt-2 pb-1.5 shadow-sm">
      <div className="surface-glass absolute bottom-full left-3 flex h-6 items-center gap-1.5 rounded-t-lg border border-b-0 border-border/45 px-2.5 text-[11px] font-medium text-muted-foreground">
        <ListOrderedIcon className="size-3" />
        Queue
        <span className="tabular-nums text-foreground/75">{entries.length}</span>
        {paused ? (
          <span className="inline-flex items-center gap-1 text-foreground/70">
            <PauseIcon className="size-3" />
            Paused
          </span>
        ) : null}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={entries.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="scrollbar-thin max-h-32 space-y-1 overflow-y-auto">
            {entries.map((entry, index) => {
              const dispatching = dispatchingEntryId === entry.id;
              const editing = editingEntryId === entry.id && editDraft?.entryId === entry.id;
              const actionsDisabled = dispatching || editingEntryId !== null;
              const label = queuedEntryLabel(entry);
              return (
                <SortableQueueRow key={entry.id} id={entry.id} disabled={reorderingDisabled}>
                  {(sortable) => (
                    <div
                      ref={sortable.setNodeRef}
                      style={{
                        transform: CSS.Translate.toString(sortable.transform),
                        transition: sortable.transition,
                      }}
                      className={cn(
                        "relative flex min-h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs",
                        "bg-muted/30 text-muted-foreground",
                        sortable.isDragging && "z-10 opacity-80",
                        dispatching && "opacity-65",
                        editing && "items-start py-1 ring-1 ring-ring/50",
                      )}
                    >
                      <button
                        ref={sortable.setActivatorNodeRef}
                        type="button"
                        aria-label={`Reorder queued item ${index + 1}: ${label}`}
                        title="Drag to reorder"
                        disabled={reorderingDisabled}
                        {...sortable.attributes}
                        {...sortable.listeners}
                        className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 outline-none hover:bg-muted hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <GripVerticalIcon aria-hidden className="size-3.5" />
                      </button>
                      <span className="w-3 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/65">
                        {index + 1}
                      </span>
                      {entry.kind === "message" && editing ? (
                        <textarea
                          autoFocus
                          rows={1}
                          aria-label={`Edit queued item ${index + 1}`}
                          value={editDraft.text}
                          onChange={(event) =>
                            setEditDraft({ entryId: entry.id, text: event.target.value })
                          }
                          onFocus={(event) => resizeQueuedMessageEditor(event.currentTarget)}
                          onInput={(event) => resizeQueuedMessageEditor(event.currentTarget)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelEdit(entry);
                              return;
                            }
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              saveEdit(entry);
                            }
                          }}
                          className="max-h-20 min-h-6 min-w-0 flex-1 resize-none rounded-md border border-border/60 bg-background/70 px-2 py-1 text-xs leading-4 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
                      )}
                      {entry.kind === "message" && entry.attachments.length > 0 ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/75">
                          <ImageIcon className="size-3" />
                          {entry.attachments.length}
                        </span>
                      ) : null}
                      {entry.kind === "message" && editing ? (
                        <>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label="Cancel editing queued follow-up"
                                  onClick={() => cancelEdit(entry)}
                                >
                                  <XIcon className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Cancel edit</TooltipPopup>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label="Save queued follow-up"
                                  disabled={
                                    !editDraft.text.trim() && entry.attachments.length === 0
                                  }
                                  onClick={() => saveEdit(entry)}
                                >
                                  <CheckIcon className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Save edit</TooltipPopup>
                          </Tooltip>
                        </>
                      ) : (
                        <>
                          {entry.kind === "message" ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label="Edit queued follow-up"
                                    disabled={actionsDisabled}
                                    onClick={() => beginEdit(entry)}
                                  >
                                    <PencilIcon className="size-3.5" />
                                  </Button>
                                }
                              />
                              <TooltipPopup side="top">Edit queued message</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label="Remove queued follow-up"
                                  disabled={actionsDisabled}
                                  onClick={() => onRemove(entry)}
                                >
                                  <XIcon className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Remove from queue</TooltipPopup>
                          </Tooltip>
                        </>
                      )}
                      {entry.kind === "message" ? (
                        !editing ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className="h-6 shrink-0 gap-1 px-2 text-[11px] text-foreground/80"
                            disabled={actionsDisabled}
                            onClick={() => onSteer(entry)}
                          >
                            <CornerDownRightIcon className="size-3" />
                            {dispatching ? "Sending…" : "Steer"}
                          </Button>
                        ) : null
                      ) : (
                        <span className="shrink-0 px-2 text-[10px] text-muted-foreground/70">
                          Runs next
                        </span>
                      )}
                      {entry.id === steerShortcutEntryId ? (
                        <SteerShortcutBadge composerDraftTarget={composerDraftTarget} />
                      ) : null}
                    </div>
                  )}
                </SortableQueueRow>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
});
