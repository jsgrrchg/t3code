import { MinusIcon, NetworkIcon, PlusIcon, ScanIcon, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  calculateAnchoredDiagramScroll,
  calculateDiagramFitScale,
  clampDiagramScale,
  type DiagramSize,
} from "../lib/diagramZoom";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface MermaidOverviewDialogProps {
  readonly open: boolean;
  readonly src: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

interface DiagramPoint {
  readonly x: number;
  readonly y: number;
}

interface DragState {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

const ZOOM_STEP = 1.25;
const TRACKPAD_ZOOM_SENSITIVITY = 0.0025;

function ZoomButton({
  label,
  children,
  onClick,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClick}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function MermaidOverviewDialog({ open, src, onOpenChange }: MermaidOverviewDialogProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const scrollFrameRef = useRef<number | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelAnchorRef = useRef<DiagramPoint | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<DiagramSize>({ width: 0, height: 0 });
  const [diagramSize, setDiagramSize] = useState<DiagramSize | null>(null);
  const [manualScale, setManualScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [dragging, setDragging] = useState(false);

  const fitScale = useMemo(
    () => (diagramSize ? calculateDiagramFitScale(viewportSize, diagramSize) : 1),
    [diagramSize, viewportSize],
  );
  const scale = fitMode ? fitScale : manualScale;
  scaleRef.current = scale;

  const bindViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewportElement(element);
  }, []);

  const scheduleScroll = useCallback(
    (nextScale: number, previousScale: number, anchor: DiagramPoint) => {
      const viewport = viewportRef.current;
      if (!viewport || !diagramSize) return;

      if (scrollFrameRef.current != null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      const nextLeft = calculateAnchoredDiagramScroll({
        scroll: viewport.scrollLeft,
        pointer: anchor.x,
        viewport: viewport.clientWidth,
        natural: diagramSize.width,
        previousScale,
        nextScale,
      });
      const nextTop = calculateAnchoredDiagramScroll({
        scroll: viewport.scrollTop,
        pointer: anchor.y,
        viewport: viewport.clientHeight,
        natural: diagramSize.height,
        previousScale,
        nextScale,
      });

      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        viewport.scrollTo({ left: nextLeft, top: nextTop });
      });
    },
    [diagramSize],
  );

  const zoomTo = useCallback(
    (requestedScale: number, anchor?: DiagramPoint) => {
      const viewport = viewportRef.current;
      if (!viewport || !diagramSize) return;

      const previousScale = scaleRef.current;
      const nextScale = clampDiagramScale(requestedScale);
      if (Math.abs(nextScale - previousScale) < 0.001) return;

      const resolvedAnchor = anchor ?? {
        x: viewport.clientWidth / 2,
        y: viewport.clientHeight / 2,
      };
      scaleRef.current = nextScale;
      setFitMode(false);
      setManualScale(nextScale);
      scheduleScroll(nextScale, previousScale, resolvedAnchor);
    },
    [diagramSize, scheduleScroll],
  );

  const fitDiagram = useCallback(() => {
    scaleRef.current = fitScale;
    setFitMode(true);
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      viewport.scrollTo({ left: 0, top: 0 });
    });
  }, [fitScale]);

  useEffect(() => {
    setDiagramSize(null);
    setFitMode(true);
    setManualScale(1);
    scaleRef.current = 1;
  }, [src]);

  useEffect(() => {
    if (open) return;
    dragStateRef.current = null;
    wheelAnchorRef.current = null;
    wheelDeltaRef.current = 0;
    setDragging(false);
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (wheelFrameRef.current != null) {
      cancelAnimationFrame(wheelFrameRef.current);
      wheelFrameRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !viewportElement) return;

    const measure = () => {
      setViewportSize({
        width: viewportElement.clientWidth,
        height: viewportElement.clientHeight,
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, [open, viewportElement]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!open || !viewport) return;

    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey || !diagramSize) return;
      event.preventDefault();

      const bounds = viewport.getBoundingClientRect();
      wheelDeltaRef.current += event.deltaY;
      wheelAnchorRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      if (wheelFrameRef.current != null) return;
      wheelFrameRef.current = requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const anchor = wheelAnchorRef.current;
        const delta = wheelDeltaRef.current;
        wheelAnchorRef.current = null;
        wheelDeltaRef.current = 0;
        if (!anchor) return;
        zoomTo(scaleRef.current * Math.exp(-delta * TRACKPAD_ZOOM_SENSITIVITY), anchor);
      });
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [diagramSize, open, zoomTo]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
      if (wheelFrameRef.current != null) cancelAnimationFrame(wheelFrameRef.current);
    },
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    dragStateRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const drag = dragStateRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    viewport.scrollTo({
      left: drag.scrollLeft - (event.clientX - drag.x),
      top: drag.scrollTop - (event.clientY - drag.y),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const scaledWidth = diagramSize ? diagramSize.width * scale : 0;
  const scaledHeight = diagramSize ? diagramSize.height * scale : 0;
  const stageWidth = Math.max(viewportSize.width, scaledWidth);
  const stageHeight = Math.max(viewportSize.height, scaledHeight);
  const imageLeft = Math.max(0, (viewportSize.width - scaledWidth) / 2);
  const imageTop = Math.max(0, (viewportSize.height - scaledHeight) / 2);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="h-[min(46rem,calc(100dvh-2rem))] w-[min(76rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-xl bg-background p-0 [-webkit-app-region:no-drag]"
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoomTo(scaleRef.current * ZOOM_STEP);
          } else if (event.key === "-") {
            event.preventDefault();
            zoomTo(scaleRef.current / ZOOM_STEP);
          } else if (event.key === "0") {
            event.preventDefault();
            fitDiagram();
          }
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-2.5">
            <DialogTitle className="flex min-w-0 items-center gap-2 font-mono text-xs font-medium">
              <NetworkIcon className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="truncate">Mermaid overview</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Expanded Mermaid diagram. Pinch on the trackpad or use the controls to zoom.
            </DialogDescription>
            <div className="flex items-center gap-0.5" role="toolbar" aria-label="Diagram zoom">
              <ZoomButton label="Zoom out" onClick={() => zoomTo(scaleRef.current / ZOOM_STEP)}>
                <MinusIcon className="size-3.5" />
              </ZoomButton>
              <button
                type="button"
                className="min-w-12 rounded px-1.5 py-1 font-mono text-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={fitDiagram}
                aria-label="Fit diagram to window"
                title="Fit diagram to window"
              >
                {Math.round(scale * 100)}%
              </button>
              <ZoomButton label="Zoom in" onClick={() => zoomTo(scaleRef.current * ZOOM_STEP)}>
                <PlusIcon className="size-3.5" />
              </ZoomButton>
              <ZoomButton label="Fit diagram" onClick={fitDiagram}>
                <ScanIcon className="size-3.5" />
              </ZoomButton>
              <DialogClose
                aria-label="Close Mermaid overview"
                render={<Button type="button" variant="ghost" size="icon-xs" />}
              >
                <XIcon className="size-3.5" />
              </DialogClose>
            </div>
          </div>
          <div
            ref={bindViewport}
            className={
              dragging
                ? "min-h-0 flex-1 cursor-grabbing overflow-auto overscroll-contain bg-muted/20"
                : "min-h-0 flex-1 cursor-grab overflow-auto overscroll-contain bg-muted/20"
            }
            data-testid="mermaid-overview-viewport"
            data-scale={scale.toFixed(4)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          >
            <div
              className="relative"
              style={{ width: stageWidth, height: stageHeight }}
              aria-live="polite"
            >
              {src ? (
                <img
                  src={src}
                  alt="Expanded Mermaid diagram"
                  className="absolute block max-w-none select-none"
                  style={{
                    left: imageLeft,
                    top: imageTop,
                    width: scaledWidth || undefined,
                    height: scaledHeight || undefined,
                  }}
                  draggable={false}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    setDiagramSize({
                      width: image.naturalWidth || image.width,
                      height: image.naturalHeight || image.height,
                    });
                  }}
                />
              ) : null}
            </div>
          </div>
          <p className="shrink-0 border-t border-border/70 px-3 py-1.5 text-center text-[10px] text-muted-foreground">
            Pinch to zoom · Scroll or drag to pan · 0 to fit
          </p>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
