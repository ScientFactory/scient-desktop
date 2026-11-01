import { describe, expect, it } from "vite-plus/test";

import { applyAppearanceFontVariables } from "./appearanceFonts";

function applySizes(sizeInterface: number, sizePrompt: number, sizeCode: number) {
  const properties = new Map<string, string>();
  const style = {
    fontSize: "",
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => properties.delete(key),
  };
  applyAppearanceFontVariables({ style } as unknown as HTMLElement, {
    separate: true,
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

describe("font size clamping", () => {
  // regression: 8eca20005b feat(web): configurable fonts and sizes under Settings → Appearance (#5103)
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
  // regression: 8eca20005b feat(web): configurable fonts and sizes under Settings → Appearance (#5103)
  it("rounds fractional values and falls back for unusable input", () => {
    expect(applySizes(Number.NaN, Number.POSITIVE_INFINITY, 15.4)).toEqual({
      interface: "17px",
      prompt: "16px",
      code: "15px",
      diff: "15px",
    });
  });
});
