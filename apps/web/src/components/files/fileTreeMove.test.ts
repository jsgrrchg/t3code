import type { FileTreeDropContext } from "@pierre/trees";
import { describe, expect, it } from "vite-plus/test";

import { fileTreeMoveDestination, resolveFileTreeMove } from "./fileTreeMove";

const entryKinds = new Map([
  ["src", "directory" as const],
  ["src/index.ts", "file" as const],
  ["components", "directory" as const],
  ["docs/my file (draft).md", "file" as const],
]);

function context(
  draggedPaths: readonly string[],
  directoryPath: string | null,
): FileTreeDropContext {
  return {
    draggedPaths,
    target:
      directoryPath === null
        ? { kind: "root", directoryPath: null, flattenedSegmentPath: null, hoveredPath: null }
        : {
            kind: "directory",
            directoryPath,
            flattenedSegmentPath: null,
            hoveredPath: directoryPath,
          },
  };
}

const policy = {
  enabled: true,
  movePending: false,
  entryKinds,
  pendingSurfaceIds: new Set<string>(),
  activeRelativePath: null,
};

describe("file tree moves", () => {
  it("calculates folder, nested folder, and root destinations", () => {
    expect(fileTreeMoveDestination("src/index.ts", context([], "components/"))).toBe(
      "components/index.ts",
    );
    expect(fileTreeMoveDestination("index.ts", context([], "src/components/"))).toBe(
      "src/components/index.ts",
    );
    expect(fileTreeMoveDestination("src/index.ts", context([], null))).toBe("index.ts");
    expect(fileTreeMoveDestination("docs/my file (draft).md", context([], "src/"))).toBe(
      "src/my file (draft).md",
    );
  });

  it("allows one file and rejects no-op, directory, and multi-selection drops", () => {
    expect(resolveFileTreeMove(context(["src/index.ts"], "components/"), policy)).toEqual({
      sourceRelativePath: "src/index.ts",
      destinationRelativePath: "components/index.ts",
    });
    expect(resolveFileTreeMove(context(["src/index.ts"], "src/"), policy)).toBeNull();
    expect(resolveFileTreeMove(context(["src/"], "components/"), policy)).toBeNull();
    expect(
      resolveFileTreeMove(context(["src/index.ts", "docs/my file (draft).md"], null), policy),
    ).toBeNull();
  });

  it("requires capability and blocks concurrent or background-pending moves", () => {
    const drop = context(["src/index.ts"], "components/");
    expect(resolveFileTreeMove(drop, { ...policy, enabled: false })).toBeNull();
    expect(resolveFileTreeMove(drop, { ...policy, movePending: true })).toBeNull();
    expect(
      resolveFileTreeMove(drop, {
        ...policy,
        pendingSurfaceIds: new Set(["file:src/index.ts"]),
      }),
    ).toBeNull();
    expect(
      resolveFileTreeMove(drop, {
        ...policy,
        pendingSurfaceIds: new Set(["file:src/index.ts"]),
        activeRelativePath: "src/index.ts",
      }),
    ).not.toBeNull();
  });

  it("rejects unknown directory targets", () => {
    expect(resolveFileTreeMove(context(["src/index.ts"], "unknown/"), policy)).toBeNull();
  });
});
