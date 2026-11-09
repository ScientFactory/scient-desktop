import { describe, expect, it } from "vite-plus/test";

import {
  markdownFenceCopySource,
  presentationFileBaseName,
  presentationPngScale,
} from "./presentationExport";

describe("presentation export primitives", () => {
  it("creates portable filenames with a format-specific fallback", () => {
    expect(presentationFileBaseName("Dose response.vl.json", "chart")).toBe("Dose-response.vl");
    expect(presentationFileBaseName("תוצאה סופית.vl.json", "chart")).toBe("תוצאה-סופית.vl");
    expect(presentationFileBaseName("***", "chart")).toBe("chart");
  });

  it("round-trips fenced source and grows the fence around embedded backticks", () => {
    expect(
      markdownFenceCopySource('{"description":"contains ``` source"}', "vega-lite", 'title="x"'),
    ).toBe('````vega-lite title="x"\n{"description":"contains ``` source"}\n````\n\n');
  });

  it("keeps PNG export within dimension and pixel bounds", () => {
    expect(presentationPngScale(429, 320, "chart")).toBe(2);
    expect(presentationPngScale(10_000, 1_000, "chart")).toBeCloseTo(0.8192);
    expect(presentationPngScale(4_096, 4_096, "chart")).toBe(1);
    expect(presentationPngScale(10_000, 10_000, "chart")).toBeCloseTo(
      Math.sqrt(16_777_216 / 100_000_000),
    );
    expect(() => presentationPngScale(0, 320, "chart")).toThrow(
      "The rendered chart has no measurable size.",
    );
  });
});
