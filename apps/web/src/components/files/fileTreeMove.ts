import type { FileTreeDropContext, FileTreeDropTarget } from "@pierre/trees";
import type { ProjectEntry } from "@t3tools/contracts";

export interface FileTreeMovePolicy {
  readonly enabled: boolean;
  readonly movePending: boolean;
  readonly entryKinds: ReadonlyMap<string, ProjectEntry["kind"]>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly activeRelativePath: string | null;
}

export interface FileTreeMoveTarget {
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
}

interface FileTreeDropEventLike {
  composedPath(): ReadonlyArray<unknown>;
}

function elementAttribute(node: unknown, name: string): string | null {
  if (typeof node !== "object" || node === null) return null;
  const element = node as { getAttribute?: (attributeName: string) => string | null };
  return typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
}

/** Resolve a Pierre folder row from a composed shadow-DOM drag event. */
export function fileTreeDirectoryDropTarget(
  event: FileTreeDropEventLike,
): FileTreeDropTarget | null {
  let flattenedSegmentPath: string | null = null;
  let hoveredPath: string | null = null;
  let directoryPath: string | null = null;
  for (const node of event.composedPath()) {
    flattenedSegmentPath ??= elementAttribute(node, "data-item-flattened-subitem");
    if (hoveredPath !== null || elementAttribute(node, "data-type") !== "item") continue;
    hoveredPath = elementAttribute(node, "data-item-path");
    if (elementAttribute(node, "data-item-type") === "folder") {
      directoryPath = hoveredPath;
    }
  }
  if (flattenedSegmentPath?.endsWith("/")) {
    return {
      kind: "directory",
      directoryPath: flattenedSegmentPath,
      flattenedSegmentPath,
      hoveredPath,
    };
  }
  return directoryPath === null
    ? null
    : { kind: "directory", directoryPath, flattenedSegmentPath: null, hoveredPath };
}

export function stripCanonicalDirectorySlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function fileTreePathBasename(path: string): string {
  const normalized = stripCanonicalDirectorySlash(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function fileTreeMoveDestination(
  sourcePath: string,
  context: Pick<FileTreeDropContext, "target">,
): string | null {
  const basename = fileTreePathBasename(sourcePath);
  if (!basename) return null;
  if (context.target.kind === "root" || context.target.directoryPath === null) return basename;
  const directory = stripCanonicalDirectorySlash(context.target.directoryPath);
  return directory ? `${directory}/${basename}` : basename;
}

export function resolveFileTreeMove(
  context: FileTreeDropContext,
  policy: FileTreeMovePolicy,
): FileTreeMoveTarget | null {
  if (!policy.enabled || policy.movePending || context.draggedPaths.length !== 1) return null;
  const draggedPath = context.draggedPaths[0];
  if (!draggedPath || draggedPath.endsWith("/")) return null;
  const sourceRelativePath = stripCanonicalDirectorySlash(draggedPath);
  if (policy.entryKinds.get(sourceRelativePath) !== "file") return null;
  if (
    policy.pendingSurfaceIds.has(`file:${sourceRelativePath}`) &&
    policy.activeRelativePath !== sourceRelativePath
  ) {
    return null;
  }
  if (context.target.kind === "directory") {
    const directoryPath = context.target.directoryPath;
    if (
      directoryPath === null ||
      policy.entryKinds.get(stripCanonicalDirectorySlash(directoryPath)) !== "directory"
    ) {
      return null;
    }
  }
  const destinationRelativePath = fileTreeMoveDestination(sourceRelativePath, context);
  if (!destinationRelativePath || destinationRelativePath === sourceRelativePath) return null;
  return { sourceRelativePath, destinationRelativePath };
}
