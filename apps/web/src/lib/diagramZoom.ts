export const MIN_DIAGRAM_SCALE = 0.05;
export const MAX_DIAGRAM_SCALE = 8;

export interface DiagramSize {
  readonly width: number;
  readonly height: number;
}

export interface AnchoredScrollInput {
  readonly scroll: number;
  readonly pointer: number;
  readonly viewport: number;
  readonly natural: number;
  readonly previousScale: number;
  readonly nextScale: number;
}

export function clampDiagramScale(scale: number): number {
  return Math.min(MAX_DIAGRAM_SCALE, Math.max(MIN_DIAGRAM_SCALE, scale));
}

export function calculateDiagramFitScale(
  viewport: DiagramSize,
  diagram: DiagramSize,
  padding = 48,
): number {
  if (viewport.width <= 0 || viewport.height <= 0 || diagram.width <= 0 || diagram.height <= 0) {
    return 1;
  }

  const availableWidth = Math.max(1, viewport.width - padding);
  const availableHeight = Math.max(1, viewport.height - padding);
  return clampDiagramScale(
    Math.min(availableWidth / diagram.width, availableHeight / diagram.height),
  );
}

export function centeredDiagramOffset(viewport: number, scaledDiagram: number): number {
  return Math.max(0, (viewport - scaledDiagram) / 2);
}

export function calculateAnchoredDiagramScroll({
  scroll,
  pointer,
  viewport,
  natural,
  previousScale,
  nextScale,
}: AnchoredScrollInput): number {
  const previousOffset = centeredDiagramOffset(viewport, natural * previousScale);
  const nextOffset = centeredDiagramOffset(viewport, natural * nextScale);
  const diagramPoint = (scroll + pointer - previousOffset) / previousScale;
  return Math.max(0, nextOffset + diagramPoint * nextScale - pointer);
}
