import type { GitStatusEntry } from "@pierre/trees";
import type { VcsStatusResult } from "@t3tools/contracts";

export function toPierreGitStatus(
  files: VcsStatusResult["workingTree"]["files"],
): ReadonlyArray<GitStatusEntry> {
  return files.map((file) => ({
    path: file.path,
    status: file.status ?? "modified",
  }));
}
