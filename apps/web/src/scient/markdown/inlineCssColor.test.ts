import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCssColor } from "./inlineCssColor";

// One row per path: the hex pattern, the color-function prefix, then Culori's full parse.
describe("resolveInlineCssColor", () => {
  it.each([
    "#fff",
    "#1b4ed880",
    "rgb(1 96 204 / 40%)",
    "oklch(0.52 0.19 262)",
    "color(display-p3 0.1 0.4 0.9)",
  ])("accepts explicit CSS color %s", (value) => {
    expect(resolveInlineCssColor(value)).toBe(value);
  });

  it.each([
    "#12345",
    "red",
    "var(--brand-color)",
    "color-mix(in srgb, red, blue)",
    "rgb(1 2)",
    "color(unknown 0.1 0.2 0.3)",
  ])("rejects unsupported or invalid inline code %s", (value) => {
    expect(resolveInlineCssColor(value)).toBeNull();
  });

  it.each([" #1b4ed8", "rgb(27, 78, 216) ", "Use rgb(27, 78, 216)"])(
    "requires the whole code span to be the color: %s",
    (value) => {
      expect(resolveInlineCssColor(value)).toBeNull();
    },
  );
});
