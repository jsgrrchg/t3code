import { describe, expect, it } from "vite-plus/test";

import { areAllDiffFilesCollapsed, isDiffFileCollapsed, toggleAllDiffFiles } from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toEqual(new Set(FILE_KEYS));
  });

  it("expands all files when every rendered file is collapsed", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set(FILE_KEYS))).toEqual(new Set());
  });

  it("applies a global fold override to files that arrive on later pages", () => {
    expect(isDiffFileCollapsed("page-2.ts", "folded", new Set(), "expanded")).toBe(true);
    expect(isDiffFileCollapsed("page-2.ts", "expanded", new Set(), "expanded")).toBe(false);
  });

  it("keeps individual file toggles as exceptions to the global override", () => {
    expect(isDiffFileCollapsed("a.ts", "folded", new Set(["a.ts"]), "expanded")).toBe(false);
    expect(isDiffFileCollapsed("a.ts", "expanded", new Set(["a.ts"]), "expanded")).toBe(true);
  });
});
