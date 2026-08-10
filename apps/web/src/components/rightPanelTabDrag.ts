import type { RightPanelSurface } from "~/rightPanelStore";

import { composerMentionFromTreePath } from "./chat/composerMentionDrag";

export function composerMentionFromRightPanelSurface(surface: RightPanelSurface): string | null {
  return surface.kind === "file" ? composerMentionFromTreePath(surface.relativePath) : null;
}
