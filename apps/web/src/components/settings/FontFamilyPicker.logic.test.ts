import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FONT_VALUE,
  getFontFamilyPreference,
  getFontPickerDisplayLabel,
  getFontPickerItems,
  getFontPickerPreviewFontFamily,
} from "./FontFamilyPicker.logic";

const pickerItems = (query: string) =>
  getFontPickerItems({
    families: ["Arial", "SF Pro"],
    query,
    defaultFamily: "SF Pro",
    defaultOptionLabel: "System default",
  });

describe("font family picker defaults", () => {
  it("keeps the semantic default and its matching installed family as distinct options", () => {
    expect(pickerItems("")).toEqual([DEFAULT_FONT_VALUE, "Arial", "SF Pro"]);
    expect(pickerItems("sf pro")).toEqual([DEFAULT_FONT_VALUE, "SF Pro"]);
  });

  it("finds the semantic default by its label without conflating unrelated fonts", () => {
    expect(pickerItems("system default")).toEqual([DEFAULT_FONT_VALUE]);
    expect(pickerItems("arial")).toEqual(["Arial"]);
  });

  it.each(["System default", "Same as interface", "Default monospace"])(
    "shows the %s semantic label only for an unset preference",
    (defaultOptionLabel) => {
      expect(getFontPickerDisplayLabel("", defaultOptionLabel)).toBe(defaultOptionLabel);
    },
  );

  it("shows an explicit family name instead of the semantic default label", () => {
    expect(getFontPickerDisplayLabel("SF Pro", "System default")).toBe("SF Pro");
  });

  it("persists the semantic default as unset and an explicit matching family by name", () => {
    expect(getFontFamilyPreference(DEFAULT_FONT_VALUE)).toBe("");
    expect(getFontFamilyPreference("SF Pro")).toBe("SF Pro");
  });

  it("previews the semantic default with its real stack, not its human-readable name", () => {
    const systemStack = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    expect(getFontPickerPreviewFontFamily(DEFAULT_FONT_VALUE, systemStack)).toBe(systemStack);
  });

  it("previews an installed family as one exact name with the real default fallback", () => {
    expect(getFontPickerPreviewFontFamily("Bodoni 72", "system-ui, sans-serif")).toBe(
      '"Bodoni 72", system-ui, sans-serif',
    );
    expect(getFontPickerPreviewFontFamily("Family, Alternate", "system-ui, sans-serif")).toBe(
      '"Family, Alternate", system-ui, sans-serif',
    );
  });
});
