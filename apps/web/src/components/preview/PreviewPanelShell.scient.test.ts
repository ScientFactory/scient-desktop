import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth } from "./PreviewPanelShell";

// Restored from the upstream-deleted PreviewPanelShell.test.ts.
describe("getPreviewPanelMaxWidth", () => {
  // regression: 9d6d045a6e fix(web): allow narrower preview and file explorer panels (#336)
  it("allows widths above the panel minimum when the row has room", () => {
    expect(getPreviewPanelMaxWidth(1_000, 700)).toBe(340);
  });

  // regression: 06dd9993b6 fix(web): reserve sibling column width when resizing the right panel (#6279)
  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    // ~1000px window with an expanded sidebar → row of 600. The sibling
    // reservation (600 − 360 = 240) would undercut the panel's own 300
    expect(getPreviewPanelMaxWidth(1_000, 600)).toBe(300);
  });

  // regression: 06dd9993b6 fix(web): reserve sibling column width when resizing the right panel (#6279)
  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getPreviewPanelMaxWidth(1_512, 300)).toBe(300);
  });
});
