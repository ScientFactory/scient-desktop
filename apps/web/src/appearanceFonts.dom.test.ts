// @vitest-environment happy-dom
import { DEFAULT_CLIENT_SETTINGS, type InterfaceFontWeight } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyAppearanceFontVariables, type AppearanceFontPreferences } from "./appearanceFonts";

const preferences: AppearanceFontPreferences = {
  sans: "",
  code: "",
  composer: "",
  sizeInterface: DEFAULT_CLIENT_SETTINGS.fontSizeInterface,
  sizePrompt: DEFAULT_CLIENT_SETTINGS.fontSizePrompt,
  sizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
  weightInterface: DEFAULT_CLIENT_SETTINGS.fontWeightInterface,
  smoothing: DEFAULT_CLIENT_SETTINGS.fontSmoothing,
};

describe("live appearance font preferences", () => {
  it("survives repeated weight changes and resets without changing font families or sizes", () => {
    const root = document.createElement("html");
    const custom = { ...preferences, sans: "Arial", code: "Menlo", composer: "Georgia" };
    const weights: InterfaceFontWeight[] = [300, 500, 400, 500, 300, 400];
    for (let repetition = 0; repetition < 50; repetition++) {
      for (const weightInterface of weights) {
        applyAppearanceFontVariables(root, { ...custom, weightInterface });
        expect(root.style.getPropertyValue("--font-weight-interface")).toBe(
          String(weightInterface),
        );
        expect(root.style.getPropertyValue("--font-weight-monospace")).toBe(
          weightInterface === 400 ? "" : "400",
        );
        expect(root.style.getPropertyValue("--font-weight-emphasis")).toBe(
          weightInterface === 400 ? "" : "700",
        );
        expect(root.style.getPropertyValue("--font-sans")).toContain("Arial");
        expect(root.style.getPropertyValue("--font-mono")).toContain("Menlo");
        expect(root.style.getPropertyValue("--font-composer")).toContain("Georgia");
        expect(root.style.fontSize).toBe("17px");
        expect(root.style.getPropertyValue("--font-size-prompt")).toBe("16px");
        expect(root.style.getPropertyValue("--diffs-font-size")).toBe("15px");
      }
    }
    applyAppearanceFontVariables(root, preferences);
    expect(root.style.getPropertyValue("--font-sans")).toBe("");
    expect(root.style.getPropertyValue("--font-mono")).toBe("");
    expect(root.style.getPropertyValue("--font-composer")).toBe("");
  });

  it.each([true, false])("keeps weight independent from font smoothing %s", (smoothing) => {
    const root = document.createElement("html");
    applyAppearanceFontVariables(root, { ...preferences, smoothing, weightInterface: 500 });
    expect(root.style.getPropertyValue("--font-weight-interface")).toBe("500");
    expect(root.style.getPropertyValue("-webkit-font-smoothing")).toBe(
      smoothing ? "antialiased" : "",
    );
  });
});
