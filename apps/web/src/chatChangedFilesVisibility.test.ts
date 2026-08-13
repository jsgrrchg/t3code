import { describe, expect, it } from "vite-plus/test";

import { resolveShowChangedFilesInChat } from "./chatChangedFilesVisibility";

describe("resolveShowChangedFilesInChat", () => {
  it("keeps changed-file cards visible outside Desktop", () => {
    expect(resolveShowChangedFilesInChat({ desktop: false, setting: false })).toBe(true);
  });

  it("uses the local preference on Desktop", () => {
    expect(resolveShowChangedFilesInChat({ desktop: true, setting: false })).toBe(false);
    expect(resolveShowChangedFilesInChat({ desktop: true, setting: true })).toBe(true);
  });
});
