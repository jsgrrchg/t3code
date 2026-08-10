import DOMPurify from "dompurify";

import { LRUCache } from "./lruCache";

export type MermaidRenderTheme = "light" | "dark";

export type MermaidRenderResult =
  | { readonly _tag: "Success"; readonly svg: string }
  | { readonly _tag: "Failure"; readonly message: string };

interface MermaidApi {
  readonly initialize: (config: Record<string, unknown>) => void;
  readonly render: (id: string, source: string) => Promise<{ readonly svg: string }>;
}

interface MermaidRendererOptions {
  readonly loadMermaid: () => Promise<MermaidApi>;
  readonly sanitizeSvg: (svg: string) => string | null;
  readonly maxCacheEntries?: number;
  readonly maxCacheMemoryBytes?: number;
  readonly maxTextSize?: number;
  readonly maxEdges?: number;
}

export interface MermaidRenderer {
  readonly render: (source: string, theme: MermaidRenderTheme) => Promise<MermaidRenderResult>;
}

const DEFAULT_MAX_TEXT_SIZE = 50_000;
const DEFAULT_MAX_EDGES = 1_000;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_MAX_CACHE_MEMORY_BYTES = 8 * 1024 * 1024;
const FAILURE_MESSAGE = "Unable to render Mermaid diagram.";
const SVG_URL_ATTRIBUTE_NAMES = new Set(["href", "src"]);
const SVG_FORBIDDEN_TAG_NAMES = new Set(["foreignobject", "script"]);
const CSS_URL_PATTERN = /url\(\s*(["']?)(.*?)\1\s*\)/gi;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cacheKey(source: string, theme: MermaidRenderTheme): string {
  return `${theme}\0${source}`;
}

function safeFailure(): MermaidRenderResult {
  return { _tag: "Failure", message: FAILURE_MESSAGE };
}

function isLocalSvgReference(value: string): boolean {
  const normalized = value.trim();
  return normalized.length === 0 || normalized.startsWith("#");
}

function hasExternalCssReference(value: string): boolean {
  if (/@import/i.test(value)) {
    return true;
  }
  for (const match of value.matchAll(CSS_URL_PATTERN)) {
    const target = match[2]?.trim() ?? "";
    if (target.length > 0 && !target.startsWith("#")) {
      return true;
    }
  }
  return false;
}

export function sanitizeMermaidSvg(svg: string): string | null {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return null;
  }

  const sanitized = DOMPurify.sanitize(svg, {
    FORBID_TAGS: ["foreignObject", "script"],
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  const document = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName.toLowerCase() !== "svg" || document.querySelector("parsererror")) {
    return null;
  }

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (SVG_FORBIDDEN_TAG_NAMES.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (SVG_URL_ATTRIBUTE_NAMES.has(name) && !isLocalSvgReference(value)) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (hasExternalCssReference(value)) {
        element.removeAttributeNode(attribute);
      }
    }

    if (element.localName.toLowerCase() === "style") {
      const css = element.textContent ?? "";
      if (hasExternalCssReference(css)) {
        element.remove();
      }
    }
  }

  const serialized = new XMLSerializer().serializeToString(root);
  return serialized.includes("<svg") ? serialized : null;
}

export function createMermaidRenderer(options: MermaidRendererOptions): MermaidRenderer {
  const maxTextSize = options.maxTextSize ?? DEFAULT_MAX_TEXT_SIZE;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
  const cache = new LRUCache<string>(
    options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
    options.maxCacheMemoryBytes ?? DEFAULT_MAX_CACHE_MEMORY_BYTES,
  );
  const pending = new Map<string, Promise<MermaidRenderResult>>();
  let modulePromise: Promise<MermaidApi> | null = null;
  let renderQueue: Promise<void> = Promise.resolve();
  let renderId = 0;

  const loadMermaid = (): Promise<MermaidApi> => {
    if (modulePromise) {
      return modulePromise;
    }
    modulePromise = options.loadMermaid().catch((cause) => {
      modulePromise = null;
      throw cause;
    });
    return modulePromise;
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = renderQueue.then(work, work);
    renderQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const render = (source: string, theme: MermaidRenderTheme): Promise<MermaidRenderResult> => {
    if (source.length === 0 || source.length > maxTextSize) {
      return Promise.resolve(safeFailure());
    }

    const key = cacheKey(source, theme);
    const cached = cache.get(key);
    if (cached !== null) {
      return Promise.resolve({ _tag: "Success", svg: cached });
    }
    const existing = pending.get(key);
    if (existing) {
      return existing;
    }

    const request = enqueue(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          maxTextSize,
          maxEdges,
          htmlLabels: false,
          theme: theme === "dark" ? "dark" : "default",
          flowchart: {
            htmlLabels: false,
            useMaxWidth: true,
          },
          secure: [
            "secure",
            "securityLevel",
            "startOnLoad",
            "maxTextSize",
            "maxEdges",
            "suppressErrorRendering",
            "htmlLabels",
            "themeCSS",
            "themeVariables",
          ],
        });
        renderId += 1;
        const rendered = await mermaid.render(`t3-mermaid-${renderId}`, source);
        const sanitized = options.sanitizeSvg(rendered.svg);
        if (!sanitized) {
          return safeFailure();
        }
        cache.set(key, sanitized, byteLength(key) + byteLength(sanitized));
        return { _tag: "Success", svg: sanitized } as const;
      } catch {
        return safeFailure();
      }
    });

    pending.set(key, request);
    void request.finally(() => {
      pending.delete(key);
    });
    return request;
  };

  return { render };
}

let defaultMermaidPromise: Promise<MermaidApi> | null = null;

function loadDefaultMermaid(): Promise<MermaidApi> {
  if (!defaultMermaidPromise) {
    defaultMermaidPromise = import("mermaid")
      .then((module) => module.default)
      .catch((cause) => {
        defaultMermaidPromise = null;
        throw cause;
      });
  }
  return defaultMermaidPromise;
}

const defaultRenderer = createMermaidRenderer({
  loadMermaid: loadDefaultMermaid,
  sanitizeSvg: sanitizeMermaidSvg,
});

export function renderMermaidDiagram(
  source: string,
  theme: MermaidRenderTheme,
): Promise<MermaidRenderResult> {
  return defaultRenderer.render(source, theme);
}
