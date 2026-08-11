import { describe, expect, it } from "vite-plus/test";

import { SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS } from "./diffPanelTypography";

describe("SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS", () => {
  it("wins inherited panel defaults without changing the shared surface theme", () => {
    expect(SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS).toContain(
      "[data-diffs-header][data-diffs-header]",
    );
    expect(SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS).toContain(
      "[data-separator-content][data-separator-content]",
    );
    expect(SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS).toContain("--scient-font-size-diff-header");
    expect(SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS).toContain("--scient-font-size-compact-meta");
  });
});
