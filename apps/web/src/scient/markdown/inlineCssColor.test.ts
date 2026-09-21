import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCssColor } from "./inlineCssColor";

describe("resolveInlineCssColor", () => {
  it.each([
    "#fff",
    "#fff8",
    "#1b4ed8",
    "#1b4ed880",
    "#ABCDEF",
    "rgb(27, 78, 216)",
    "rgb(1 96 204)",
    "rgb(231, 43, 43)",
    "rgba(0, 0, 0, 0.08)",
    "rgba(255, 255, 255, 0.64)",
    "rgb(1 96 204 / 40%)",
    "hsl(222, 78%, 48%)",
    "hsl(210 100% 40%)",
    "hsla(0, 80%, 54%, 0.5)",
    "hwb(214 0% 20%)",
    "oklab(0.52 0.02 -0.19)",
    "oklch(0.52 0.19 262)",
    "oklch(62% 0.21 29)",
    "oklch(0.98 0.005 285)",
    "lab(54% 70 50)",
    "lch(54% 86 36)",
    "color(display-p3 0.1 0.4 0.9)",
    "color(srgb 0.99 0.17 0.21)",
  ])("accepts explicit CSS color %s", (value) => {
    expect(resolveInlineCssColor(value)).toBe(value);
  });

  it.each([
    "",
    "#12",
    "#12345",
    "#1234567",
    "#gggggg",
    "0x1b4ed8",
    "#theme-blue",
    "red",
    "transparent",
    "currentColor",
    "var(--brand-color)",
    "color-mix(in srgb, red, blue)",
    "rgb(1 2)",
    "color(unknown 0.1 0.2 0.3)",
  ])("rejects unsupported or invalid inline code %s", (value) => {
    expect(resolveInlineCssColor(value)).toBeNull();
  });

  it.each([
    " #1b4ed8",
    "#1b4ed8 ",
    "The color is #1b4ed8",
    " rgb(27, 78, 216)",
    "rgb(27, 78, 216) ",
    "Use rgb(27, 78, 216)",
  ])("requires the whole code span to be the color: %s", (value) => {
    expect(resolveInlineCssColor(value)).toBeNull();
  });
});
