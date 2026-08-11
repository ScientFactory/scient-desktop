import { describe, expect, it } from "vite-plus/test";

import { resolveThemePickerHexCommit } from "./ThemeColorPicker";

describe("resolveThemePickerHexCommit", () => {
  it("preserves the current alpha when the picker changes RGB", () => {
    expect(resolveThemePickerHexCommit("#A1B2C3", "oklch(0.62 0.2 280 / 0.5)")).toBe("#a1b2c380");
  });

  it("keeps opaque colors as six-digit hex", () => {
    expect(resolveThemePickerHexCommit("#A1B2C3", "oklch(0.62 0.2 280)")).toBe("#a1b2c3");
  });

  it("does not commit incomplete or unsupported hex input", () => {
    expect(resolveThemePickerHexCommit("#a1b2c", "#12345680")).toBeNull();
    expect(resolveThemePickerHexCommit("#a1b2c3ff", "#12345680")).toBeNull();
  });
});
