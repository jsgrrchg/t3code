// @vitest-environment jsdom

import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMermaidRenderer,
  sanitizeMermaidSvg,
  type MermaidRenderTheme,
} from "./mermaidRendering";

function svg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`;
}

function fakeMermaid(options?: {
  readonly failFirstRender?: boolean;
  readonly renderDelay?: () => Promise<void>;
}) {
  let renderCount = 0;
  const initialize = vi.fn();
  const render = vi.fn(async (id: string, source: string) => {
    renderCount += 1;
    await options?.renderDelay?.();
    if (options?.failFirstRender && renderCount === 1) {
      throw new Error("parse failed");
    }
    return { svg: svg(`${id}:${source}`) };
  });
  return { initialize, render };
}

function rendererWith(
  mermaid: ReturnType<typeof fakeMermaid>,
  overrides?: {
    readonly maxCacheEntries?: number;
    readonly maxCacheMemoryBytes?: number;
    readonly loadMermaid?: () => Promise<ReturnType<typeof fakeMermaid>>;
  },
) {
  const loadMermaid = vi.fn(overrides?.loadMermaid ?? (async () => mermaid));
  return {
    loadMermaid,
    renderer: createMermaidRenderer({
      loadMermaid,
      sanitizeSvg: sanitizeMermaidSvg,
      ...(overrides?.maxCacheEntries === undefined
        ? {}
        : { maxCacheEntries: overrides.maxCacheEntries }),
      ...(overrides?.maxCacheMemoryBytes === undefined
        ? {}
        : { maxCacheMemoryBytes: overrides.maxCacheMemoryBytes }),
    }),
  };
}

describe("sanitizeMermaidSvg", () => {
  it("removes executable elements, handlers, foreign objects, and external URLs", () => {
    const sanitized = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
        <a href="https://example.test/track"><text>external</text></a>
        <a href="#local-shape"><text>local</text></a>
        <style>@import url("https://example.test/theme.css");</style>
      </svg>
    `);

    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("https://example.test");
    expect(sanitized).toContain('href="#local-shape"');
  });

  it("rejects non-SVG output", () => {
    expect(sanitizeMermaidSvg("<div>not svg</div>")).toBeNull();
  });
});

describe("createMermaidRenderer", () => {
  it("loads Mermaid lazily and shares the module and identical pending work", async () => {
    let releaseRender: (() => void) | undefined;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const mermaid = fakeMermaid({ renderDelay: () => renderGate });
    const { loadMermaid, renderer } = rendererWith(mermaid);

    expect(loadMermaid).not.toHaveBeenCalled();
    const first = renderer.render("flowchart LR\nA-->B", "light");
    const duplicate = renderer.render("flowchart LR\nA-->B", "light");
    expect(loadMermaid).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(loadMermaid).toHaveBeenCalledTimes(1);
    releaseRender?.();

    expect(await first).toEqual(await duplicate);
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    await renderer.render("flowchart LR\nB-->C", "light");
    expect(loadMermaid).toHaveBeenCalledTimes(1);
  });

  it("serializes theme-specific renders and configures strict limits", async () => {
    const events: string[] = [];
    const mermaid = {
      initialize: vi.fn((config: Record<string, unknown>) => {
        events.push(`initialize:${String(config.theme)}`);
      }),
      render: vi.fn(async (_id: string, source: string) => {
        events.push(`render:${source}`);
        return { svg: svg(source) };
      }),
    };
    const { renderer } = rendererWith(mermaid);

    await Promise.all([
      renderer.render("light-source", "light"),
      renderer.render("dark-source", "dark"),
    ]);

    expect(events).toEqual([
      "initialize:default",
      "render:light-source",
      "initialize:dark",
      "render:dark-source",
    ]);
    expect(mermaid.initialize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        maxTextSize: 50_000,
        maxEdges: 1_000,
        htmlLabels: false,
      }),
    );
  });

  it("caches by source and theme and evicts the least recently used entry", async () => {
    const mermaid = fakeMermaid();
    const { renderer } = rendererWith(mermaid, { maxCacheEntries: 2 });
    const render = (source: string, theme: MermaidRenderTheme = "light") =>
      renderer.render(source, theme);

    await render("a");
    await render("b");
    await render("a");
    await render("c");
    await render("b");
    await render("a", "dark");

    expect(mermaid.render).toHaveBeenCalledTimes(5);
  });

  it("does not retain failed renders or failed module loads", async () => {
    const mermaid = fakeMermaid({ failFirstRender: true });
    let loadAttempts = 0;
    const { renderer } = rendererWith(mermaid, {
      loadMermaid: async () => {
        loadAttempts += 1;
        if (loadAttempts === 1) {
          throw new Error("chunk unavailable");
        }
        return mermaid;
      },
    });

    expect((await renderer.render("retry", "light"))._tag).toBe("Failure");
    expect((await renderer.render("retry", "light"))._tag).toBe("Failure");
    expect((await renderer.render("retry", "light"))._tag).toBe("Success");
    expect(loadAttempts).toBe(2);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("rejects empty, oversized, and invalid sanitized results without loading unnecessarily", async () => {
    const mermaid = fakeMermaid();
    const loadMermaid = vi.fn(async () => mermaid);
    const renderer = createMermaidRenderer({
      loadMermaid,
      sanitizeSvg: () => null,
      maxTextSize: 8,
    });

    expect((await renderer.render("", "light"))._tag).toBe("Failure");
    expect((await renderer.render("123456789", "light"))._tag).toBe("Failure");
    expect(loadMermaid).not.toHaveBeenCalled();
    expect((await renderer.render("valid", "light"))._tag).toBe("Failure");
    expect(loadMermaid).toHaveBeenCalledTimes(1);
  });
});
