import { describe, expect, it } from "vite-plus/test";

import { renderScientTexToHtml } from "./katexRuntime";
import {
  getScientKatexRuntimePromise,
  isLikelyCurrencyText,
  shouldRenderMathAsCurrency,
} from "./ScientMath";

describe("isLikelyCurrencyText", () => {
  it("treats digits and money punctuation as prose", () => {
    expect(isLikelyCurrencyText("5-")).toBe(true);
    expect(isLikelyCurrencyText("10")).toBe(true);
    expect(isLikelyCurrencyText("1,000.50")).toBe(true);
    expect(isLikelyCurrencyText(" 12 - 15 ")).toBe(true);
  });

  it("treats digit-led prose without math structure as prose", () => {
    expect(isLikelyCurrencyText("5 and ")).toBe(true);
    expect(isLikelyCurrencyText("2 apples")).toBe(true);
    expect(isLikelyCurrencyText("10 or so")).toBe(true);
  });

  it("treats anything with a control sequence or math structure as math", () => {
    expect(isLikelyCurrencyText("x^2")).toBe(false);
    expect(isLikelyCurrencyText("\\alpha")).toBe(false);
    expect(isLikelyCurrencyText("5x")).toBe(false);
    expect(isLikelyCurrencyText("\\frac{1}{2}")).toBe(false);
    expect(isLikelyCurrencyText("5 \\cdot 4")).toBe(false);
    expect(isLikelyCurrencyText("5 = five")).toBe(false);
    expect(isLikelyCurrencyText("and 5")).toBe(false);
  });

  it("needs a digit to look like money", () => {
    expect(isLikelyCurrencyText("")).toBe(false);
    expect(isLikelyCurrencyText("+-")).toBe(false);
  });
});

describe("shouldRenderMathAsCurrency", () => {
  it("never treats display math as money — $$ around a number is an equation", () => {
    expect(shouldRenderMathAsCurrency("42", true)).toBe(false);
    expect(shouldRenderMathAsCurrency("5 - 3", true)).toBe(false);
  });

  it("treats ambiguous single-dollar spans as money", () => {
    expect(shouldRenderMathAsCurrency("5-", false)).toBe(true);
    expect(shouldRenderMathAsCurrency("5 and ", false)).toBe(true);
    expect(shouldRenderMathAsCurrency("x^2", false)).toBe(false);
  });
});

describe("renderScientTexToHtml", () => {
  it("renders KaTeX markup for both modes", () => {
    const inline = renderScientTexToHtml("x^2", false);
    expect(inline).toContain("katex");
    expect(inline).toContain("<math");

    expect(renderScientTexToHtml("x^2", true)).toContain("katex-display");
  });

  it("colors an unknown command instead of throwing", () => {
    const html = renderScientTexToHtml("\\badcmd", false);

    // `throwOnError: false` echoes the source in KaTeX's error color.
    expect(html).toContain("#cc0000");
    expect(html).toContain("\\badcmd");
  });
});

describe("getScientKatexRuntimePromise", () => {
  it("requests the runtime chunk once", async () => {
    const first = getScientKatexRuntimePromise();

    expect(getScientKatexRuntimePromise()).toBe(first);
    await expect(first).resolves.toHaveProperty("renderScientTexToHtml", renderScientTexToHtml);
  });
});
