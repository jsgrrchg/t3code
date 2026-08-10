import { GitGraph } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildStandardSurfaceActions } from "./RightPanelTabs";
import {
  RIGHT_PANEL_ADD_MENU_SURFACE_ORDER,
  RIGHT_PANEL_EMPTY_SURFACE_ORDER,
} from "./RightPanelTabs.logic";

function actions(historyAvailable: boolean, historyDisabledReason: string) {
  return buildStandardSurfaceActions({
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddFiles: vi.fn(),
    onAddDiff: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddHistory: vi.fn(),
    onAddAgents: vi.fn(),
    browserAvailable: true,
    terminalAvailable: true,
    filesAvailable: true,
    diffAvailable: true,
    pullRequestAvailable: true,
    historyAvailable,
    historyDisabledReason,
    agentsAvailable: true,
    liveAgentCount: 0,
  });
}

describe("History right-panel presentation", () => {
  it("places History in the sixth empty-state card without moving Agents", () => {
    const presentation = actions(true, "");

    expect(RIGHT_PANEL_EMPTY_SURFACE_ORDER).toEqual([
      "browser",
      "terminal",
      "files",
      "diff",
      "pull-request",
      "agents",
      "history",
    ]);
    expect(RIGHT_PANEL_EMPTY_SURFACE_ORDER.map((kind) => presentation[kind].label)).toEqual([
      "Browser",
      "Terminal",
      "Files",
      "Diff",
      "Pull request",
      "Agents",
      "History",
    ]);
  });

  it("places History immediately after Diff in the add menu", () => {
    const presentation = actions(true, "");

    expect(RIGHT_PANEL_ADD_MENU_SURFACE_ORDER.map((kind) => presentation[kind].label)).toEqual([
      "Browser",
      "Terminal",
      "Files",
      "Diff",
      "Pull request",
      "History",
      "Agents",
    ]);
  });

  it("uses the GitGraph icon, History title, description, and dynamic disabled reason", () => {
    const disabledReason = "The connected server needs to support Git history.";
    const history = actions(false, disabledReason).history;

    expect(history.icon).toBe(GitGraph);
    expect(history.label).toBe("History");
    expect(history.description).toBe("Browse the repository commit graph.");
    expect(history.available).toBe(false);
    expect(history.disabledReason).toBe(disabledReason);
  });
});
