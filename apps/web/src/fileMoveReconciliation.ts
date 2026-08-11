import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import type { ReviewCommentContext } from "./reviewCommentContext";

export type PendingFileSurfaceIdsByWorkspace = ReadonlyMap<string, ReadonlySet<string>>;

export function workspaceFileStateKey(input: {
  environmentId: string;
  projectWorkspaceRoot: string | null | undefined;
  worktreePath: string | null | undefined;
}): string | null {
  const workspaceRoot = input.worktreePath ?? input.projectWorkspaceRoot;
  return workspaceRoot ? JSON.stringify([input.environmentId, workspaceRoot]) : null;
}

export function updatePendingFileSurface(
  currentByWorkspace: PendingFileSurfaceIdsByWorkspace,
  workspaceKey: string,
  relativePath: string,
  pending: boolean,
): PendingFileSurfaceIdsByWorkspace {
  const current = currentByWorkspace.get(workspaceKey) ?? new Set<string>();
  const surfaceId = `file:${relativePath}`;
  if (current.has(surfaceId) === pending) return currentByWorkspace;
  const next = new Set(current);
  if (pending) next.add(surfaceId);
  else next.delete(surfaceId);
  const nextByWorkspace = new Map(currentByWorkspace);
  if (next.size === 0) nextByWorkspace.delete(workspaceKey);
  else nextByWorkspace.set(workspaceKey, next);
  return nextByWorkspace;
}

export function clearPendingFileMoveSurfaces(
  currentByWorkspace: PendingFileSurfaceIdsByWorkspace,
  workspaceKey: string,
  sourceRelativePath: string,
  destinationRelativePath: string,
): PendingFileSurfaceIdsByWorkspace {
  const current = currentByWorkspace.get(workspaceKey);
  if (!current) return currentByWorkspace;
  const next = new Set(current);
  next.delete(`file:${sourceRelativePath}`);
  next.delete(`file:${destinationRelativePath}`);
  if (next.size === current.size) return currentByWorkspace;
  const nextByWorkspace = new Map(currentByWorkspace);
  if (next.size === 0) nextByWorkspace.delete(workspaceKey);
  else nextByWorkspace.set(workspaceKey, next);
  return nextByWorkspace;
}

export function remapComposerFileTokens(
  prompt: string,
  sourceRelativePath: string,
  destinationRelativePath: string,
): string {
  // The tokenizer recognizes mentions at a boundary. A synthetic trailing
  // boundary lets an exact token at the end of the draft participate too.
  const replacements = collectComposerInlineTokens(`${prompt} `)
    .filter((token) => token.end <= prompt.length)
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
