import type { VcsStatusResult, VcsWorkingTreeFileStatus } from "@t3tools/contracts";

export interface FileTreeGitPresentation {
  readonly directoriesWithChanges: ReadonlySet<string>;
  readonly statusByPath: ReadonlyMap<string, VcsWorkingTreeFileStatus>;
}

export function buildFileTreeGitPresentation(
  files: VcsStatusResult["workingTree"]["files"],
): FileTreeGitPresentation {
  const directoriesWithChanges = new Set<string>();
  const statusByPath = new Map<string, VcsWorkingTreeFileStatus>();

  for (const file of files) {
    statusByPath.set(file.path, file.status ?? "modified");
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoriesWithChanges.add(segments.slice(0, index).join("/"));
    }
  }

  return { directoriesWithChanges, statusByPath };
}
