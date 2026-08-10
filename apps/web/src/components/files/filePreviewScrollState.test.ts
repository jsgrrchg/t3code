import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createFilePreviewScrollMemory,
  filePreviewScrollKey,
  type FilePreviewScrollMode,
} from "./filePreviewScrollState";

const threadA = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-a"));
const threadB = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-b"));

function key(
  mode: FilePreviewScrollMode,
  overrides: Partial<{
    threadRef: typeof threadA;
    cwd: string;
    relativePath: string;
  }> = {},
) {
  return filePreviewScrollKey({
    threadRef: overrides.threadRef ?? threadA,
    cwd: overrides.cwd ?? "/workspace",
    relativePath: overrides.relativePath ?? "README.md",
    mode,
  });
}

describe("file preview scroll state", () => {
  it("isolates positions by thread, workspace, path, and view mode", () => {
    expect(key("markdown")).not.toBe(key("source"));
    expect(key("markdown")).not.toBe(key("markdown", { threadRef: threadB }));
    expect(key("markdown")).not.toBe(key("markdown", { cwd: "/other" }));
    expect(key("markdown")).not.toBe(key("markdown", { relativePath: "docs/getting-started.md" }));
  });

  it("returns a defensive normalized copy", () => {
    const memory = createFilePreviewScrollMemory();
    const scrollKey = key("markdown");
    memory.set(scrollKey, {
      position: { top: Number.POSITIVE_INFINITY, left: -20 },
      revealRequestId: -1,
    });

    const remembered = memory.get(scrollKey);
    expect(remembered).toEqual({
      position: { top: 0, left: 0 },
      revealRequestId: null,
    });
    if (remembered) {
      (remembered.position as { top: number }).top = 500;
    }
    expect(memory.get(scrollKey)?.position.top).toBe(0);
  });

  it("evicts the least recently used entry", () => {
    const memory = createFilePreviewScrollMemory(2);
    const first = key("source", { relativePath: "first.ts" });
    const second = key("source", { relativePath: "second.ts" });
    const third = key("source", { relativePath: "third.ts" });
    const entry = { position: { top: 10, left: 5 }, revealRequestId: null };

    memory.set(first, entry);
    memory.set(second, entry);
    expect(memory.get(first)).not.toBeNull();
    memory.set(third, entry);

    expect(memory.get(second)).toBeNull();
    expect(memory.get(first)).not.toBeNull();
    expect(memory.get(third)).not.toBeNull();
    expect(memory.size).toBe(2);
  });
});
