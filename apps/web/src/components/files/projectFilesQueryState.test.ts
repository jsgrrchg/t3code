import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getProjectDirectoryQueryAtom,
  getProjectEntriesQueryAtom,
  getOptimisticProjectFileQueryData,
  isDirectProjectChildPath,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.unstubAllGlobals();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });

  it("keeps visible and ignored workspace listings in separate query atoms", () => {
    const visible = getProjectEntriesQueryAtom(environmentId, "/repo");
    const withIgnored = getProjectEntriesQueryAtom(environmentId, "/repo", true);

    expect(getProjectEntriesQueryAtom(environmentId, "/repo", false)).toBe(visible);
    expect(getProjectEntriesQueryAtom(environmentId, "/repo", true)).toBe(withIgnored);
    expect(withIgnored).not.toBe(visible);
  });

  it("keys directory listing pages independently", () => {
    const root = getProjectDirectoryQueryAtom(environmentId, "/repo", "", true);
    const src = getProjectDirectoryQueryAtom(environmentId, "/repo", "src", true);
    const srcNext = getProjectDirectoryQueryAtom(
      environmentId,
      "/repo",
      "src",
      true,
      "Composer.tsx",
    );

    expect(getProjectDirectoryQueryAtom(environmentId, "/repo", "", true)).toBe(root);
    expect(src).not.toBe(root);
    expect(srcNext).not.toBe(src);
  });

  it("distinguishes direct children from deeper descendants", () => {
    expect(isDirectProjectChildPath("README.md", "")).toBe(true);
    expect(isDirectProjectChildPath("src/index.ts", "")).toBe(false);
    expect(isDirectProjectChildPath("src/index.ts", "src")).toBe(true);
    expect(isDirectProjectChildPath("src/components/Button.tsx", "src")).toBe(false);
  });
});
