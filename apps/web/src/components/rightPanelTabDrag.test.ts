import { describe, expect, it } from "@effect/vitest";

import { composerMentionFromRightPanelSurface } from "./rightPanelTabDrag.ts";

describe("composerMentionFromRightPanelSurface", () => {
  it("serializes file tabs as composer mentions", () => {
    expect(
      composerMentionFromRightPanelSurface({
        id: "file:docs/My Plan.md",
        kind: "file",
        relativePath: "docs/My Plan.md",
        revealLine: null,
        revealRequestId: 0,
      }),
    ).toBe("[My Plan.md](docs/My%20Plan.md)");
  });

  it("does not make workspace utility tabs draggable", () => {
    expect(composerMentionFromRightPanelSurface({ id: "diff", kind: "diff" })).toBeNull();
    expect(composerMentionFromRightPanelSurface({ id: "files", kind: "files" })).toBeNull();
    expect(composerMentionFromRightPanelSurface({ id: "agents", kind: "agents" })).toBeNull();
  });
});
