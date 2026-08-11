import type { FileTreeDropContext } from "@pierre/trees";
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
