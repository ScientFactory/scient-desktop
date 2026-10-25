import { describe, expect, it } from "vite-plus/test";

import { buildTabContextMenuItems } from "./RightPanelTabs";

describe("RightPanelTabs context menu", () => {
  it("offers explicit relative and full path actions for file tabs", () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: ["relative", "full"],
        mute: null,
        surfaceIndex: 0,
        surfaceCount: 2,
      }).map(({ id, label }) => ({ id, label })),
    ).toEqual([
      { id: "copy-relative-path", label: "Copy relative path" },
      { id: "copy-full-path", label: "Copy full path" },
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close others" },
      { id: "close-to-right", label: "Close to the right" },
      { id: "close-all", label: "Close all" },
    ]);
  });

  // regression: d75449ca1d fix(files): reliable copy paths and calm file-failure states (#400)
  it("offers only a full path for host files outside the workspace", () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: ["full"],
        mute: null,
        surfaceIndex: 0,
        surfaceCount: 1,
      }).map((item) => item.id),
    ).toEqual(["copy-full-path", "close", "close-others", "close-to-right", "close-all"]);
  });

  it("preserves the preview mute action alongside the shared close actions", () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: [],
        mute: { label: "Unmute tab", disabled: false },
        surfaceIndex: 0,
        surfaceCount: 1,
      }).map(({ id, label, disabled }) => ({ id, label, disabled: disabled ?? false })),
    ).toEqual([
      { id: "toggle-mute", label: "Unmute tab", disabled: false },
      { id: "close", label: "Close", disabled: false },
      { id: "close-others", label: "Close others", disabled: true },
      { id: "close-to-right", label: "Close to the right", disabled: true },
      { id: "close-all", label: "Close all", disabled: false },
    ]);
  });
});
