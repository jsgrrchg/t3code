import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import type { ReviewCommentContext } from "~/reviewCommentContext";

export function remapComposerFileTokens(
  prompt: string,
  sourceRelativePath: string,
  destinationRelativePath: string,
): string {
  const replacements = collectComposerInlineTokens(prompt)
    .filter((token) => token.type === "mention" && token.value === sourceRelativePath)
    .toReversed();
  if (replacements.length === 0) return prompt;
  const serializedDestination = serializeComposerFileLink(destinationRelativePath);
  let next = prompt;
  for (const token of replacements) {
    next = `${next.slice(0, token.start)}${serializedDestination}${next.slice(token.end)}`;
  }
  return next;
}

export function remapFileReviewComments(
  comments: ReadonlyArray<ReviewCommentContext>,
  sourceRelativePath: string,
  destinationRelativePath: string,
): ReadonlyArray<ReviewCommentContext> {
  const sourceSectionId = `file:${sourceRelativePath}`;
  const destinationSectionId = `file:${destinationRelativePath}`;
  return comments.map((comment) =>
    comment.sectionId === sourceSectionId && comment.filePath === sourceRelativePath
      ? {
          ...comment,
          sectionId: destinationSectionId,
          filePath: destinationRelativePath,
        }
      : comment,
  );
}
