// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { MermaidRenderResult } from "../lib/mermaidRendering";
import { MermaidBlock, type MermaidBlockProps } from "./MermaidBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T) {
      resolve?.(value);
    },
  };
}

describe("MermaidBlock", () => {
  let container: HTMLDivElement;
  let root: Root;
  let objectUrlIndex: number;

  const sourceView = (code: string): ReactNode => <pre data-testid="source">{code}</pre>;

  const render = async (props: Omit<MermaidBlockProps, "sourceView">) => {
    await act(async () => {
      root.render(<MermaidBlock {...props} sourceView={sourceView(props.code)} />);
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    objectUrlIndex = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mermaid-${++objectUrlIndex}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows loading, creates an SVG Blob URL, and revokes it on unmount", async () => {
    const result = deferred<MermaidRenderResult>();
    const renderer = vi.fn(() => result.promise);
    await render({ code: "flowchart LR\nA-->B", theme: "light", renderer });

    expect(container.textContent).toContain("Rendering diagram…");
    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      result.resolve({
        _tag: "Success",
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ready</text></svg>',
      });
      await result.promise;
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:mermaid-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mermaid-1");
    root = createRoot(container);
  });

  it("hides a stale themed image immediately and ignores its late result", async () => {
    const light = deferred<MermaidRenderResult>();
    const dark = deferred<MermaidRenderResult>();
    const renderer = vi.fn((_code: string, theme: "light" | "dark") =>
      theme === "light" ? light.promise : dark.promise,
    );

    await render({ code: "flowchart LR\nA-->B", theme: "light", renderer });
    await render({ code: "flowchart LR\nA-->B", theme: "dark", renderer });
    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      light.resolve({ _tag: "Success", svg: "<svg><text>light</text></svg>" });
      await light.promise;
    });
    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      dark.resolve({ _tag: "Success", svg: "<svg><text>dark</text></svg>" });
      await dark.promise;
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:mermaid-1");
  });

  it("shows the original source on failure and retries from the toolbar", async () => {
    const renderer = vi
      .fn<NonNullable<MermaidBlockProps["renderer"]>>()
      .mockResolvedValueOnce({ _tag: "Failure", message: "Unable to render Mermaid diagram." })
      .mockResolvedValueOnce({ _tag: "Success", svg: "<svg />" });
    const code = "flowchart invalid";
    await render({ code, theme: "light", renderer });
    await act(async () => undefined);

    expect(container.querySelector("[data-testid='source']")?.textContent).toBe(code);
    expect(container.textContent).toContain("Unable to render Mermaid diagram.");

    const retry = container.querySelector<HTMLButtonElement>("button[aria-label='Retry diagram']");
    await act(async () => retry?.click());
    await act(async () => undefined);

    expect(renderer).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("toggles the source without rerendering and copies the exact source", async () => {
    const code = "sequenceDiagram\nA->>B: hello";
    const renderer = vi.fn(async () => ({ _tag: "Success", svg: "<svg />" }) as const);
    await render({ code, theme: "light", renderer });
    await act(async () => undefined);

    const showSource = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Show source']",
    );
    await act(async () => showSource?.click());
    expect(container.querySelector("[data-testid='source']")?.textContent).toBe(code);

    const copy = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Copy Mermaid source']",
    );
    await act(async () => copy?.click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code);
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it("preserves source line annotations for rendered Markdown reviews", async () => {
    const renderer = vi.fn(async () => ({ _tag: "Success", svg: "<svg />" }) as const);
    await render({
      code: "flowchart LR\nA-->B",
      theme: "light",
      renderer,
      sourceStartLine: 12,
      sourceEndLine: 15,
    });

    const block = container.querySelector("[data-language='mermaid']");
    expect(block?.getAttribute("data-markdown-source-start")).toBe("12");
    expect(block?.getAttribute("data-markdown-source-end")).toBe("15");
  });
});
