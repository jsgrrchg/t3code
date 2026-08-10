import { describe, expect, it } from "vite-plus/test";

import { fileBreadcrumbs, pathFallsWithinEntry } from "./filePath";

describe("fileBreadcrumbs", () => {
  it("builds project, directory, and file crumbs", () => {
    expect(fileBreadcrumbs("t3code", "apps/web/src/main.tsx")).toEqual([
      { label: "t3code", path: "", kind: "project" },
      { label: "apps", path: "apps", kind: "directory" },
      { label: "web", path: "apps/web", kind: "directory" },
      { label: "src", path: "apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "apps/web/src/main.tsx", kind: "file" },
    ]);
  });

  it("normalizes repeated separators", () => {
    expect(fileBreadcrumbs("workspace", "/src//index.ts").map((crumb) => crumb.label)).toEqual([
      "workspace",
      "src",
      "index.ts",
    ]);
  });
});

describe("pathFallsWithinEntry", () => {
  it("matches an entry and its descendants without matching path prefixes", () => {
    expect(pathFallsWithinEntry("src/index.ts", "src")).toBe(true);
    expect(pathFallsWithinEntry("src", "src")).toBe(true);
    expect(pathFallsWithinEntry("src-generated/index.ts", "src")).toBe(false);
  });
});
