import { describe, expect, it } from "vite-plus/test";

import {
  plotlyFileBaseName,
  plotlyMarkdownCopySource,
  plotlyPngBlob,
  plotlySvgBlob,
} from "./plotlyExport";
import type { PlotlyViewController } from "./PlotlyView";

describe("Plotly exports", () => {
  it("uses stable portable source filenames and Markdown copying", () => {
    expect(plotlyFileBaseName("Dose response.plotly.json")).toBe("Dose-response");
    expect(plotlyFileBaseName(null)).toBe("plotly-chart");
    expect(plotlyMarkdownCopySource('{"data":[]}', "plotly", 'title="Dose"')).toBe(
      '```plotly title="Dose"\n{"data":[]}\n```\n\n',
    );
  });

  it("decodes Plotly's PNG and SVG data URLs without rerendering source", async () => {
    const controller = {
      getDimensions: () => ({ height: 100, width: 200 }),
      getInteractionMode: () => "zoom" as const,
      getState: () => null,
      reset: async () => undefined,
      setInteractionMode: async () => undefined,
      setState: async () => undefined,
      toImage: async (format: "png" | "svg") =>
        format === "png"
          ? "data:image/png;base64,AA=="
          : "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
    } satisfies PlotlyViewController;

    const png = await plotlyPngBlob(controller);
    const svg = await plotlySvgBlob(controller);

    expect(png).toMatchObject({ size: 1, type: "image/png" });
    expect(svg.type).toBe("image/svg+xml");
    expect(await svg.text()).toContain("<svg");
  });

  it("rejects malformed and mismatched export results", async () => {
    const controller = {
      getDimensions: () => ({ height: 100, width: 200 }),
      getInteractionMode: () => "zoom" as const,
      getState: () => null,
      reset: async () => undefined,
      setInteractionMode: async () => undefined,
      setState: async () => undefined,
      toImage: async () => "https://example.test/not-an-image",
    } satisfies PlotlyViewController;

    await expect(plotlyPngBlob(controller)).rejects.toThrow("invalid image URL");
    controller.toImage = async () => "data:text/plain;base64,AA==";
    await expect(plotlySvgBlob(controller)).rejects.toThrow("instead of 'image/svg+xml'");
  });
});
