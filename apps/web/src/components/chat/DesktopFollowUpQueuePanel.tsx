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
import {
  CornerDownRightIcon,
  GripVerticalIcon,
  ImageIcon,
  ListOrderedIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, type ReactNode } from "react";

import type {
  DesktopQueuedFollowUp,
  DesktopQueuedMessageFollowUp,
} from "../../desktopFollowUpQueueStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
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

export const DesktopFollowUpQueuePanel = memo(function DesktopFollowUpQueuePanel({
  entries,
  dispatchingEntryId,
  paused,
  onRemove,
  onReorder,
  onSteer,
}: {
  readonly entries: ReadonlyArray<DesktopQueuedFollowUp>;
  readonly dispatchingEntryId: string | null;
  readonly paused: boolean;
  readonly onRemove: (entry: DesktopQueuedFollowUp) => void;
  readonly onReorder: (entryId: string, overEntryId: string) => void;
  readonly onSteer: (entry: DesktopQueuedMessageFollowUp) => void;
}) {
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

  if (entries.length === 0) return null;

  const reorderingDisabled =
    dispatchingEntryId !== null && entries.some((entry) => entry.id === dispatchingEntryId);

  return (
    <div className="chat-composer-glass relative mt-6 rounded-xl border border-border/45 px-2 pt-2 pb-1.5 shadow-sm">
      <div className="chat-composer-glass absolute bottom-full left-3 flex h-6 items-center gap-1.5 rounded-t-lg border border-b-0 border-border/45 px-2.5 text-[11px] font-medium text-muted-foreground">
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
                        "flex min-h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs",
                        "bg-muted/30 text-muted-foreground",
                        sortable.isDragging && "z-10 opacity-80",
                        dispatching && "opacity-65",
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
                      <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
                      {entry.kind === "message" && entry.attachments.length > 0 ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/75">
                          <ImageIcon className="size-3" />
                          {entry.attachments.length}
                        </span>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Remove queued follow-up"
                              disabled={dispatching}
                              onClick={() => onRemove(entry)}
                            >
                              <XIcon className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">Remove from queue</TooltipPopup>
                      </Tooltip>
                      {entry.kind === "message" ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="h-6 shrink-0 gap-1 px-2 text-[11px] text-foreground/80"
                          disabled={dispatching}
                          onClick={() => onSteer(entry)}
                        >
                          <CornerDownRightIcon className="size-3" />
                          {dispatching ? "Sending…" : "Steer"}
                        </Button>
                      ) : (
                        <span className="shrink-0 px-2 text-[10px] text-muted-foreground/70">
                          Runs next
                        </span>
                      )}
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
