import { describe, expect, it } from "vite-plus/test";

import { applyAppearanceFontVariables, cssFontFamilyName } from "./appearanceFonts";

function applySizes(sizeInterface: number, sizePrompt: number, sizeCode: number) {
  const properties = new Map<string, string>();
  const style = {
    fontSize: "",
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => properties.delete(key),
  };
  applyAppearanceFontVariables({ style } as unknown as HTMLElement, {
    sans: "",
    code: "",
    composer: "",
    sizeInterface,
    sizePrompt,
    sizeCode,
    weightInterface: 400,
    smoothing: true,
  });
  return {
    interface: style.fontSize,
    prompt: properties.get("--font-size-prompt"),
    code: properties.get("--font-size-code"),
    diff: properties.get("--diffs-font-size"),
  };
}

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

describe("font size clamping", () => {
  it("keeps sizes inside the ranges the UI can absorb", () => {
    expect(applySizes(18, 40, 1)).toEqual({
      interface: "18px",
      prompt: "20px",
      code: "10px",
      diff: "10px",
    });
    expect(applySizes(2, 16, 14).interface).toBe("12px");
    expect(applySizes(96, 16, 14).interface).toBe("20px");
  });
  it("rounds fractional values and falls back for unusable input", () => {
    expect(applySizes(Number.NaN, Number.POSITIVE_INFINITY, 15.4)).toEqual({
      interface: "17px",
      prompt: "16px",
      code: "15px",
      diff: "15px",
    });
  });
});
