import { MessageCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import type { ReviewCommentContext } from "~/reviewCommentContext";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { nextFileCommentId } from "./fileCommentAnnotations";
import { LocalCommentAnnotation } from "./LocalCommentAnnotation";

export interface MarkdownSourceRange {
  startLine: number;
  endLine: number;
}

interface MarkdownReviewSurfaceProps {
  comments: ReadonlyArray<ReviewCommentContext>;
  children: React.ReactNode;
  onComment: (input: MarkdownSourceRange & { id: string; text: string }) => void;
  onDelete: (commentId: string) => void;
}

interface PositionedRange extends MarkdownSourceRange {
  top: number;
}

function sameRange(left: MarkdownSourceRange | null, right: MarkdownSourceRange | null): boolean {
  return left?.startLine === right?.startLine && left?.endLine === right?.endLine;
}

function rangeFromElement(element: Element | null): MarkdownSourceRange | null {
  if (!(element instanceof HTMLElement)) return null;
  const startLine = Number(element.dataset.markdownSourceStart);
  const endLine = Number(element.dataset.markdownSourceEnd);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return null;
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  };
}

function rangeLabel(range: MarkdownSourceRange): string {
  return range.startLine === range.endLine
    ? `L${range.startLine}`
    : `L${range.startLine} to L${range.endLine}`;
}

function commentMatchesRange(comment: ReviewCommentContext, range: MarkdownSourceRange): boolean {
  return comment.startIndex + 1 === range.startLine && comment.endIndex + 1 === range.endLine;
}

export function MarkdownReviewSurface({
  comments,
  children,
  onComment,
  onDelete,
}: MarkdownReviewSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<PositionedRange | null>(null);
  const [active, setActive] = useState<PositionedRange | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const displayedRange = open ? active : hovered;
  const displayedComments = useMemo(
    () =>
      displayedRange
        ? comments.filter((comment) => commentMatchesRange(comment, displayedRange))
        : [],
    [comments, displayedRange],
  );

  const positionRange = useCallback((element: HTMLElement): PositionedRange | null => {
    const root = rootRef.current;
    const range = rangeFromElement(element);
    if (!root || !range) return null;
    const rootRect = root.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    return {
      ...range,
      top: elementRect.top - rootRect.top + Math.min(12, Math.max(0, elementRect.height / 2 - 10)),
    };
  }, []);

  const handlePointerOver = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (open) return;
      const element = (event.target as Element).closest<HTMLElement>(
        "[data-markdown-source-start][data-markdown-source-end]",
      );
      // Keep the last block active while the pointer crosses the left rail or
      // enters its floating action. Clearing here would unmount the button
      // before its click can land; leaving the whole surface still clears it.
      if (!element) return;
      const next = positionRange(element);
      setHovered((current) =>
        sameRange(current, next) && current?.top === next?.top ? current : next,
      );
    },
    [open, positionRange],
  );

  const close = useCallback(() => {
    setOpen(false);
    setActive(null);
    setDraft(null);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks = root.querySelectorAll<HTMLElement>(
      "[data-markdown-source-start][data-markdown-source-end]",
    );
    for (const block of blocks) {
      const range = rangeFromElement(block);
      block.toggleAttribute(
        "data-markdown-has-comment",
        range !== null && comments.some((comment) => commentMatchesRange(comment, range)),
      );
      block.toggleAttribute(
        "data-markdown-comment-active",
        range !== null && active !== null && sameRange(range, active),
      );
    }
  }, [active, comments, children]);

  const openComments = useCallback(() => {
    if (!displayedRange) return;
    const rangeComments = comments.filter((comment) =>
      commentMatchesRange(comment, displayedRange),
    );
    setActive(displayedRange);
    setDraft(rangeComments.length === 0 ? { id: nextFileCommentId(), text: "" } : null);
    setOpen(true);
  }, [comments, displayedRange]);

  const addDraft = useCallback(() => {
    setDraft({ id: nextFileCommentId(), text: "" });
  }, []);

  const submitDraft = useCallback(
    (text: string) => {
      if (!active || !draft) return;
      onComment({ ...active, id: draft.id, text });
      setDraft(null);
    },
    [active, draft, onComment],
  );

  const commentCount = displayedRange
    ? comments.filter((comment) => commentMatchesRange(comment, displayedRange)).length
    : 0;

  return (
    <div
      ref={rootRef}
      className="markdown-review-surface relative"
      onPointerOver={handlePointerOver}
      onPointerLeave={() => {
        if (!open) setHovered(null);
      }}
    >
      {children}
      {displayedRange ? (
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) close();
          }}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="absolute left-0 z-10 rounded-full bg-background shadow-sm"
                style={{ top: displayedRange.top }}
                aria-label={commentCount > 0 ? `View ${commentCount} comments` : "Add comment"}
                onClick={openComments}
              />
            }
          >
            {commentCount > 0 ? (
              <span className="relative">
                <MessageCircle className="size-3" />
                {commentCount > 1 ? (
                  <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1 text-[8px] leading-3 text-primary-foreground">
                    {commentCount}
                  </span>
                ) : null}
              </span>
            ) : (
              <Plus className="size-3" />
            )}
          </PopoverTrigger>
          <PopoverPopup align="start" side="right" className="w-80" viewportClassName="p-0">
            <div className="divide-y divide-border/30">
              {displayedComments.map((comment) => (
                <LocalCommentAnnotation
                  key={comment.id}
                  kind="comment"
                  rangeLabel={comment.rangeLabel}
                  text={comment.text}
                  onCancel={() => onDelete(comment.id)}
                  onComment={() => {}}
                  onDelete={() => onDelete(comment.id)}
                />
              ))}
              {draft && active ? (
                <LocalCommentAnnotation
                  kind="draft"
                  rangeLabel={rangeLabel(active)}
                  text={draft.text}
                  onTextChange={(text) =>
                    setDraft((current) => (current ? { ...current, text } : current))
                  }
                  onCancel={() => {
                    if (displayedComments.length > 0) setDraft(null);
                    else close();
                  }}
                  onComment={submitDraft}
                  onDelete={() => setDraft(null)}
                />
              ) : (
                <div className="p-2">
                  <Button variant="ghost" size="xs" className="w-full" onClick={addDraft}>
                    <Plus className="size-3" />
                    Add another comment
                  </Button>
                </div>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
