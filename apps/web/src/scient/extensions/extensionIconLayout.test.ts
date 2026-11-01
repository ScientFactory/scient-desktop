import { describe, expect, it } from "vite-plus/test";
import { extensionMarkLayout } from "./extensionIconLayout";

describe("runtime icon normalization", () => {
  it("removes asymmetric alpha margins and centres a contained mark at 70%", () => {
    const pixels = new Uint8ClampedArray(100 * 80 * 4);
    for (let y = 20; y < 40; y++) {
      for (let x = 10; x < 50; x++) pixels[(y * 100 + x) * 4 + 3] = 255;
    }
    const layout = extensionMarkLayout(pixels, 100, 80)!;
    expect(layout.source).toEqual([10, 20, 40, 20]);
    const [x, y, width, height] = layout.destination;
    expect(width).toBeCloseTo(256 * 0.7);
    expect(height / width).toBeCloseTo(0.5);
    expect(x + width / 2).toBeCloseTo(128);
    expect(y + height / 2).toBeCloseTo(128);
  });

  it("leaves opaque tiles and empty images alone", () => {
    expect(extensionMarkLayout(new Uint8Array(4 * 4 * 4).fill(255), 4, 4)).toBeUndefined();
    expect(extensionMarkLayout(new Uint8Array(4 * 4 * 4), 4, 4)).toBeUndefined();
  });
});
