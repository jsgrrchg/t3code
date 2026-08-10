import {
  CheckIcon,
  Code2Icon,
  CopyIcon,
  Maximize2Icon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  renderMermaidDiagram,
  type MermaidRenderResult,
  type MermaidRenderTheme,
} from "../lib/mermaidRendering";
import { MermaidOverviewDialog } from "./MermaidOverviewDialog";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type MermaidBlockState =
  | { readonly key: string; readonly status: "loading" }
  | { readonly key: string; readonly status: "ready"; readonly svg: string }
  | { readonly key: string; readonly status: "error"; readonly message: string };

type MermaidDiagramRenderer = (
  source: string,
  theme: MermaidRenderTheme,
) => Promise<MermaidRenderResult>;

export interface MermaidBlockProps {
  readonly code: string;
  readonly theme: MermaidRenderTheme;
  readonly sourceView: ReactNode;
  readonly sourceStartLine?: number | undefined;
  readonly sourceEndLine?: number | undefined;
  readonly renderer?: MermaidDiagramRenderer | undefined;
}

function renderKey(code: string, theme: MermaidRenderTheme, retry: number): string {
  return `${theme}\0${retry}\0${code}`;
}

export function MermaidBlock({
  code,
  theme,
  sourceView,
  sourceStartLine,
  sourceEndLine,
  renderer = renderMermaidDiagram,
}: MermaidBlockProps) {
  const [mode, setMode] = useState<"diagram" | "code">("diagram");
  const [retry, setRetry] = useState(0);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const key = useMemo(() => renderKey(code, theme, retry), [code, retry, theme]);
  const [state, setState] = useState<MermaidBlockState>({ key, status: "loading" });
  const [objectUrl, setObjectUrl] = useState<{ readonly key: string; readonly url: string } | null>(
    null,
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Mermaid source",
  });
  const visibleState: MermaidBlockState = state.key === key ? state : { key, status: "loading" };
  const successfulSvg = visibleState.status === "ready" ? visibleState.svg : null;
  const visibleObjectUrl = objectUrl?.key === key ? objectUrl.url : null;
  const showingSource = mode === "code" || visibleState.status === "error";
  const modeLabel = showingSource ? "Show diagram" : "Show source";
  const copyLabel = isCopied ? "Copied" : "Copy Mermaid source";

  useEffect(() => {
    let active = true;
    setState({ key, status: "loading" });
    void renderer(code, theme).then((result) => {
      if (!active) return;
      setState(
        result._tag === "Success"
          ? { key, status: "ready", svg: result.svg }
          : { key, status: "error", message: result.message },
      );
    });
    return () => {
      active = false;
    };
  }, [code, key, renderer, theme]);

  useEffect(() => {
    if (!successfulSvg) {
      return;
    }
    const url = URL.createObjectURL(new Blob([successfulSvg], { type: "image/svg+xml" }));
    setObjectUrl({ key, url });
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [key, successfulSvg]);

  useEffect(() => {
    if (!visibleObjectUrl) {
      setOverviewOpen(false);
    }
  }, [visibleObjectUrl]);

  const toggleMode = () => {
    if (showingSource) {
      setMode("diagram");
      if (visibleState.status === "error") {
        setRetry((value) => value + 1);
      }
      return;
    }
    setMode("code");
  };

  return (
    <div
      className="chat-markdown-codeblock chat-markdown-mermaid border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language="mermaid"
      data-markdown-source-start={sourceStartLine}
      data-markdown-source-end={sourceEndLine}
      data-view={showingSource ? "code" : "diagram"}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <NetworkIcon className="size-3.5" aria-hidden />
          <span className="truncate">Mermaid</span>
        </span>
        <span
          className="flex items-center gap-0.5"
          role="toolbar"
          aria-label="Mermaid block actions"
        >
          {visibleState.status === "error" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    onClick={() => setRetry((value) => value + 1)}
                    aria-label="Retry diagram"
                  />
                }
              >
                <RefreshCwIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Retry diagram</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  disabled={!visibleObjectUrl || showingSource}
                  onClick={() => setOverviewOpen(true)}
                  aria-label="Expand Mermaid diagram"
                />
              }
            >
              <Maximize2Icon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Expand Mermaid diagram</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={showingSource}
                  onClick={toggleMode}
                  aria-label={modeLabel}
                />
              }
            >
              {showingSource ? (
                <NetworkIcon className="size-3" />
              ) : (
                <Code2Icon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{modeLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={() => copyToClipboard(code, undefined)}
                  aria-label={copyLabel}
                />
              }
            >
              {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {showingSource ? (
        <div className="chat-markdown-mermaid-source">{sourceView}</div>
      ) : visibleObjectUrl ? (
        <div className="chat-markdown-mermaid-diagram">
          <img src={visibleObjectUrl} alt="Mermaid diagram" />
        </div>
      ) : (
        <div className="chat-markdown-mermaid-loading" role="status">
          Rendering diagram…
        </div>
      )}
      {visibleState.status === "error" ? (
        <div className="chat-markdown-mermaid-error" role="status">
          {visibleState.message}
        </div>
      ) : null}
      <MermaidOverviewDialog
        open={overviewOpen}
        src={visibleObjectUrl}
        onOpenChange={setOverviewOpen}
      />
    </div>
  );
}
