import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("allows widths above the panel minimum when the row has room", () => {
    expect(getPreviewPanelMaxWidth(1_000, 700)).toBe(340);
  });

  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    // ~1000px window with an expanded sidebar → row of 600. The sibling
    // reservation (600 − 360 = 240) would undercut the panel's own 300
    expect(getPreviewPanelMaxWidth(1_000, 600)).toBe(300);
  });

  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getPreviewPanelMaxWidth(1_512, 300)).toBe(300);
  });
});
