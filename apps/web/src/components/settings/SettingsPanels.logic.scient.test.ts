import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatAboutVersionLabel,
  getChangedTypographySettingLabels,
  shouldShowDesktopUpdateChannelSelector,
} from "./SettingsPanels.logic";

describe("about version label", () => {
  // regression: e08dc7e7d0 fix(desktop): keep Scient updates on the stable track
  it("distinguishes development builds without changing release version labels", () => {
    expect(formatAboutVersionLabel("0.0.42", "Dev")).toBe("0.0.42 · Dev");
    expect(formatAboutVersionLabel("0.6.13", null)).toBe("0.6.13");
  });
});

describe("desktop update channel selector", () => {
  it("stays hidden for a stable-only compatibility policy", () => {
    expect(
      shouldShowDesktopUpdateChannelSelector({
        hasDesktopBridge: true,
        policy: "stable-only",
      }),
    ).toBe(false);
  });

  it("remains available to products that deliberately expose channel selection", () => {
    expect(
      shouldShowDesktopUpdateChannelSelector({
        hasDesktopBridge: true,
        policy: "user-selectable",
      }),
    ).toBe(true);
    expect(
      shouldShowDesktopUpdateChannelSelector({
        hasDesktopBridge: false,
        policy: "user-selectable",
      }),
    ).toBe(false);
  });
});

describe("typography settings restore", () => {
  it("detects a weight-only change", () => {
    expect(
      getChangedTypographySettingLabels({ ...DEFAULT_UNIFIED_SETTINGS, fontWeightInterface: 300 }),
    ).toEqual(["Interface font"]);
  });
  it("detects family and size changes by font row", () => {
    expect(getChangedTypographySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeInterface: 19,
        fontFamilyCode: "Fira Code",
      }),
    ).toEqual(["Interface font", "Code font"]);
  });
});
