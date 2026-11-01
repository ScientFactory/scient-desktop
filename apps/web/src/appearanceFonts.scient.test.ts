import { DEFAULT_CLIENT_SETTINGS, type InterfaceFontWeight } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAppearanceFontVariables,
  cssFontFamilyName,
  type AppearanceFontPreferences,
} from "./appearanceFonts";

// regression: 901a58418a fix(web): render font picker previews reliably
describe("cssFontFamilyName", () => {
  it("quotes one exact family instead of interpreting its punctuation", () => {
    expect(cssFontFamilyName("Bodoni 72")).toBe('"Bodoni 72"');
    expect(cssFontFamilyName("Family, Alternate")).toBe('"Family, Alternate"');
  });
  it("escapes CSS string delimiters and control characters", () => {
    expect(cssFontFamilyName('A "Quoted" \\ Family')).toBe('"A \\"Quoted\\" \\\\ Family"');
    expect(cssFontFamilyName("Line\nBreak")).toBe('"Line\\a Break"');
  });
  it("returns null for an empty family", () => {
    expect(cssFontFamilyName("")).toBeNull();
    expect(cssFontFamilyName("   ")).toBeNull();
  });
});

const preferences: AppearanceFontPreferences = {
  separate: true,
  sans: "",
  code: "",
  composer: "",
  sizeInterface: DEFAULT_CLIENT_SETTINGS.fontSizeInterface,
  sizePrompt: DEFAULT_CLIENT_SETTINGS.fontSizePrompt,
  sizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
  weightInterface: DEFAULT_CLIENT_SETTINGS.fontWeightInterface,
  smoothing: DEFAULT_CLIENT_SETTINGS.fontSmoothing,
};

function styleRoot() {
  const properties = new Map<string, string>();
  const style = {
    fontSize: "",
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => properties.delete(key),
    getPropertyValue: (key: string) => properties.get(key) ?? "",
  };
  return { root: { style } as unknown as HTMLElement, style };
}

describe("interface text weight", () => {
  it("changes prose weight only, keeping monospace weight, families, sizes and smoothing", () => {
    const { root, style } = styleRoot();
    const custom = { ...preferences, sans: "Arial", code: "Menlo", composer: "Georgia" };
    const weights: InterfaceFontWeight[] = [300, 500, 400, 500];
    for (const [index, weightInterface] of weights.entries()) {
      applyAppearanceFontVariables(root, {
        ...custom,
        weightInterface,
        smoothing: index % 2 === 0,
      });
      expect(style.getPropertyValue("--font-weight-interface")).toBe(String(weightInterface));
      expect(style.getPropertyValue("--font-weight-monospace")).toBe(
        weightInterface === 400 ? "" : "400",
      );
      expect(style.getPropertyValue("--font-weight-emphasis")).toBe(
        weightInterface === 400 ? "" : "700",
      );
      expect(style.getPropertyValue("--font-sans")).toContain("Arial");
      expect(style.getPropertyValue("--font-mono")).toContain("Menlo");
      expect(style.getPropertyValue("--font-composer")).toContain("Georgia");
      expect(style.fontSize).toBe("17px");
      expect(style.getPropertyValue("--font-size-prompt")).toBe("16px");
      expect(style.getPropertyValue("--diffs-font-size")).toBe("15px");
    }
    applyAppearanceFontVariables(root, preferences);
    expect(style.getPropertyValue("--font-sans")).toBe("");
    expect(style.getPropertyValue("--font-mono")).toBe("");
    expect(style.getPropertyValue("--font-composer")).toBe("");
  });
});
