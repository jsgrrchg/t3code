import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GitHistoryGraphCell, getGitHistoryGraphWidth } from "./GitHistoryGraphCell";
import { layoutGitHistoryGraph } from "./gitHistoryGraphLayout";

const MERGE_SHA = "3333333333333333333333333333333333333333";
const FIRST_PARENT_SHA = "2222222222222222222222222222222222222222";
const SECOND_PARENT_SHA = "1111111111111111111111111111111111111111";

describe("GitHistoryGraphCell", () => {
  it("renders a decorative SVG with paths and one node", () => {
    const layout = layoutGitHistoryGraph([
      {
        sha: MERGE_SHA,
        parentShas: [FIRST_PARENT_SHA, SECOND_PARENT_SHA],
        subject: "Merge",
        authorName: "Test Author",
        authorEmail: "test@example.com",
        authoredAt: "2026-08-10T00:00:00Z",
      },
    ]);
    const html = renderToStaticMarkup(
      <GitHistoryGraphCell row={layout.rows[0]!} laneCount={layout.maxLaneCount} />,
    );

    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<path/g)).toHaveLength(2);
    expect(html.match(/<circle/g)).toHaveLength(1);
    expect(html).toContain("pointer-events-none");
    expect(html).not.toContain("animate");
  });

  it("grows the gutter width with the maximum loaded lane count", () => {
    expect(getGitHistoryGraphWidth(3)).toBeGreaterThan(getGitHistoryGraphWidth(2));
    expect(getGitHistoryGraphWidth(0)).toBe(getGitHistoryGraphWidth(1));
  });
});
