import { CornerDownRightIcon, ImageIcon, ListOrderedIcon, XIcon } from "lucide-react";
import { memo } from "react";

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

export const DesktopFollowUpQueuePanel = memo(function DesktopFollowUpQueuePanel({
  entries,
  dispatchingEntryId,
  onRemove,
  onSteer,
}: {
  readonly entries: ReadonlyArray<DesktopQueuedFollowUp>;
  readonly dispatchingEntryId: string | null;
  readonly onRemove: (entry: DesktopQueuedFollowUp) => void;
  readonly onSteer: (entry: DesktopQueuedMessageFollowUp) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="chat-composer-glass relative mt-6 rounded-xl border border-border/45 px-2 pt-2 pb-1.5 shadow-sm">
      <div className="chat-composer-glass absolute bottom-full left-3 flex h-6 items-center gap-1.5 rounded-t-lg border border-b-0 border-border/45 px-2.5 text-[11px] font-medium text-muted-foreground">
        <ListOrderedIcon className="size-3" />
        Queue
        <span className="tabular-nums text-foreground/75">{entries.length}</span>
      </div>
      <div className="scrollbar-thin max-h-32 space-y-1 overflow-y-auto">
        {entries.map((entry, index) => {
          const dispatching = dispatchingEntryId === entry.id;
          return (
            <div
              key={entry.id}
              className={cn(
                "flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-xs",
                "bg-muted/30 text-muted-foreground",
                dispatching && "opacity-65",
              )}
            >
              <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/65">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/85">
                {queuedEntryLabel(entry)}
              </span>
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
          );
        })}
      </div>
    </div>
  );
});
