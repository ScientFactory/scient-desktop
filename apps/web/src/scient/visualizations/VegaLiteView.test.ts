import { describe, expect, it } from "vite-plus/test";

import { isMeaningfulVegaLiteWidthChange, VEGA_LITE_RESIZE_EPSILON } from "./vegaLiteResize";

describe("VegaLiteView responsive resize policy", () => {
  it("accepts the first measurable width and later material width changes", () => {
    expect(isMeaningfulVegaLiteWidthChange(null, 640)).toBe(true);
    expect(isMeaningfulVegaLiteWidthChange(640, 720)).toBe(true);
  });

  it("ignores invalid, hidden, repeated, and subpixel-only measurements", () => {
    expect(isMeaningfulVegaLiteWidthChange(null, 0)).toBe(false);
    expect(isMeaningfulVegaLiteWidthChange(null, Number.NaN)).toBe(false);
    expect(isMeaningfulVegaLiteWidthChange(640, 640)).toBe(false);
    expect(isMeaningfulVegaLiteWidthChange(640, 640 + VEGA_LITE_RESIZE_EPSILON / 2)).toBe(false);
  });
});
