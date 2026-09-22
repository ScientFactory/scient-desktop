import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("allows the panel to use 70% of an ultra-wide viewport without a pixel ceiling", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(4_200);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getPreviewPanelMaxWidth(2_001)).toBe(1_400);
  });

  it("reserves the sibling column minimum when the flex row is known", () => {
    // Fullscreen 14" MacBook: viewport 1512, sidebar ~256 → row of 1256.
    // The 70% fraction (1058) would leave the chat column only ~198px;
    // the container clamp caps the panel at 1256 − 360 instead.
    expect(getPreviewPanelMaxWidth(1_512, 1_256)).toBe(896);
  });

  it("keeps the fraction cap when the row is wide enough for both columns", () => {
    expect(getPreviewPanelMaxWidth(3_000, 2_900)).toBe(2_100);
  });

  it("rounds fractional row widths down", () => {
    expect(getPreviewPanelMaxWidth(1_512, 1_256.6)).toBe(896);
  });

  it("allows widths above the panel minimum when the row has room", () => {
    expect(getPreviewPanelMaxWidth(1_000, 700)).toBe(340);
  });

  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    // ~1000px window with an expanded sidebar → row of 600. The sibling
    // reservation (600 − 360 = 240) would undercut the panel's own 300
    // minimum and invert the resize clamp, so the floor wins.
    expect(getPreviewPanelMaxWidth(1_000, 600)).toBe(300);
  });

  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getPreviewPanelMaxWidth(1_512, 300)).toBe(300);
  });
});
