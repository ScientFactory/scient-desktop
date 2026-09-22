import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FONT_VALUE,
  getFontFamilyPreference,
  getFontPickerDisplayLabel,
  getFontPickerItems,
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
});
