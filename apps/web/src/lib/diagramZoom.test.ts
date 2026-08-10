import { describe, expect, it } from "vite-plus/test";

import {
  calculateAnchoredDiagramScroll,
  calculateDiagramFitScale,
  clampDiagramScale,
} from "./diagramZoom";

describe("diagramZoom", () => {
  it("fits wide and tall diagrams inside the available viewport", () => {
    expect(
      calculateDiagramFitScale({ width: 1000, height: 700 }, { width: 2000, height: 500 }),
    ).toBeCloseTo(0.476);
    expect(
      calculateDiagramFitScale({ width: 1000, height: 700 }, { width: 400, height: 1600 }),
    ).toBeCloseTo(0.4075);
  });

  it("clamps manual zoom to safe bounds", () => {
    expect(clampDiagramScale(0.001)).toBe(0.05);
    expect(clampDiagramScale(20)).toBe(8);
  });

  it("keeps the same diagram point under the pointer while zooming", () => {
    const scroll = calculateAnchoredDiagramScroll({
      scroll: 200,
      pointer: 300,
      viewport: 800,
      natural: 1200,
      previousScale: 1,
      nextScale: 2,
    });

    expect(scroll).toBe(700);
  });

  it("accounts for centered diagrams before they overflow", () => {
    const scroll = calculateAnchoredDiagramScroll({
      scroll: 0,
      pointer: 400,
      viewport: 800,
      natural: 400,
      previousScale: 1,
      nextScale: 2,
    });

    expect(scroll).toBe(0);
  });
});
