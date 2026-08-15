import { describe, expect, it } from "vite-plus/test";

import { markdownFenceCopySource, presentationFileBaseName } from "./presentationExport";

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
});
