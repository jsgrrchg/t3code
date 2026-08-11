import { describe, expect, it } from "vite-plus/test";

import { getElectronPlatformClassNames } from "./windowControlsOverlay";

describe("getElectronPlatformClassNames", () => {
  it("marks macOS desktop renderers for native sidebar material styling", () => {
    expect(getElectronPlatformClassNames("MacIntel")).toEqual(["electron", "electron-macos"]);
  });

  it("preserves the Windows-specific class", () => {
    expect(getElectronPlatformClassNames("Win32")).toEqual(["electron", "electron-windows"]);
  });

  it("uses only the shared Electron class on Linux", () => {
    expect(getElectronPlatformClassNames("Linux x86_64")).toEqual(["electron"]);
  });
});
