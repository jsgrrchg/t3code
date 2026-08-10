import { describe, expect, it } from "vite-plus/test";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  resolvePathAgainstCwd,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("resolves workspace paths using the cwd path style", () => {
    expect(resolvePathAgainstCwd("src/main.ts", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/main.ts",
    );
    expect(resolvePathAgainstCwd("src/main.ts", "C:\\Users\\julius\\project")).toBe(
      "C:\\Users\\julius\\project\\src\\main.ts",
    );
    expect(resolvePathAgainstCwd("src/main.ts", "C:/Users/julius/project")).toBe(
      "C:\\Users\\julius\\project\\src\\main.ts",
    );
    expect(resolvePathAgainstCwd("docs", "/")).toBe("/docs");
    expect(resolvePathAgainstCwd("src/main.ts", "\\\\server\\share\\project\\")).toBe(
      "\\\\server\\share\\project\\src\\main.ts",
    );
  });

  it("keeps absolute workspace paths unchanged", () => {
    expect(resolvePathAgainstCwd("/repo/src/main.ts", "/other")).toBe("/repo/src/main.ts");
    expect(resolvePathAgainstCwd("D:\\repo\\src\\main.ts", "C:\\other")).toBe(
      "D:\\repo\\src\\main.ts",
    );
  });
});
