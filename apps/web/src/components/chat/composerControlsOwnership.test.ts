import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  matchesDefault: true,
  shownInStrip: false,
  hasTraits: true,
  planModeUiEnabled: false,
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  // SCIENT-FORK:START — Permissions open their own card; the effort menu never holds them.
  it("keeps a permissions icon at the default instead of folding it into the effort menu", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "icon",
      showModeBlock: true,
      hiddenBlockIds: [],
    });
  });

  it("leaves Permissions to the new-thread strip button", () => {
    const result = resolveComposerControlsOwnership({ ...base, shownInStrip: true });
    expect(result).toMatchObject({ accessDisplay: "hidden", showModeBlock: false });
  });
  // SCIENT-FORK:END

  it("shows a labelled chip when the mode differs", () => {
    const result = resolveComposerControlsOwnership({ ...base, matchesDefault: false });
    expect(result).toMatchObject({ accessDisplay: "label", showModeBlock: true });
  });

  it("overflows only the Plan toggle while the strip holds Permissions", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      shownInStrip: true,
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(false);
  });

  it("overflows the permissions chip into the overflow menu", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
  });

  it("shows the non-default chip as an icon in the compacted row", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      collapsed: true,
    });
    expect(result.accessDisplay).toBe("icon");
  });
});
