import { describe, expect, it } from "vite-plus/test";

import { shouldRenderMermaidDiagram } from "./markdownDiagrams";

describe("shouldRenderMermaidDiagram", () => {
  it.each(["mermaid", "Mermaid", "MERMAID"])("recognizes %s fences when enabled", (language) => {
    expect(shouldRenderMermaidDiagram({ language, enabled: true, isStreaming: false })).toBe(true);
  });

  it("keeps Mermaid as code when diagrams are not enabled", () => {
    expect(
      shouldRenderMermaidDiagram({ language: "mermaid", enabled: false, isStreaming: false }),
    ).toBe(false);
  });

  it("keeps incomplete streaming Mermaid as code", () => {
    expect(
      shouldRenderMermaidDiagram({ language: "mermaid", enabled: true, isStreaming: true }),
    ).toBe(false);
  });

  it("does not intercept other fenced languages", () => {
    expect(
      shouldRenderMermaidDiagram({ language: "typescript", enabled: true, isStreaming: false }),
    ).toBe(false);
  });
});
