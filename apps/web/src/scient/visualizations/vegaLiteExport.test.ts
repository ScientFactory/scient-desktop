import { describe, expect, it, vi } from "vite-plus/test";

import {
  vegaLiteFileBaseName,
  vegaLiteMarkdownCopySource,
  vegaLitePngBlob,
  vegaLitePngScale,
} from "./vegaLiteExport";
import type { VegaLiteViewController } from "./VegaLiteView";

describe("Vega-Lite export", () => {
  it("normalizes common Vega-Lite source extensions", () => {
    expect(vegaLiteFileBaseName("dose response.vl.json")).toBe("dose-response");
    expect(vegaLiteFileBaseName("cohort.vega-lite.json")).toBe("cohort");
    expect(vegaLiteFileBaseName("chart.json")).toBe("chart");
    expect(vegaLiteFileBaseName(null)).toBe("chart");
  });

  it("preserves the complete fenced source for message copy", () => {
    expect(vegaLiteMarkdownCopySource('{"mark":"bar"}', "vl", 'title="study"')).toBe(
      '```vl title="study"\n{"mark":"bar"}\n```\n\n',
    );
  });

  it("keeps PNG export within dimension and pixel bounds", () => {
    expect(vegaLitePngScale(429, 320)).toBe(2);
    expect(vegaLitePngScale(10_000, 1_000)).toBeCloseTo(0.8192);
    expect(vegaLitePngScale(4_096, 4_096)).toBe(1);
    expect(() => vegaLitePngScale(0, 320)).toThrow("no measurable size");
  });

  it("bounds the first canvas render instead of measuring with an unbounded canvas", async () => {
    const canvas = {
      height: 640,
      toBlob: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })),
      width: 858,
    } as HTMLCanvasElement;
    const toCanvas = vi.fn(async () => canvas);
    const controller = {
      getDimensions: () => ({ height: 320, width: 429 }),
      toCanvas,
    } as unknown as VegaLiteViewController;

    await expect(vegaLitePngBlob(controller)).resolves.toMatchObject({ type: "image/png" });
    expect(toCanvas).toHaveBeenCalledOnce();
    expect(toCanvas).toHaveBeenCalledWith(2);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });
});
