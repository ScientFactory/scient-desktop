import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { VegaLiteChartCard } from "./VegaLiteChartCard";

describe("VegaLiteChartCard server fallback", () => {
  it("keeps valid source canonical before the lazy browser render starts", () => {
    const source = JSON.stringify({
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      description: "Treatment response by week",
      data: { values: [{ week: 1, response: 4 }] },
      mark: "line",
      encoding: {
        x: { field: "week", type: "quantitative" },
        y: { field: "response", type: "quantitative" },
      },
    });
    const html = renderToStaticMarkup(
      createElement(VegaLiteChartCard, {
        fenceMeta: 'title="response.vl.json"',
        language: "vega-lite",
        source,
        theme: "light",
        title: "response.vl.json",
      }),
    );

    expect(html).toContain('role="figure"');
    expect(html).toContain("response.vl.json");
    expect(html).toContain("Chart will render when visible");
    expect(html).toContain("Treatment response by week");
    expect(html).toContain("title=&quot;response.vl.json&quot;");
    expect(html).not.toContain("vega-embed");
  });

  it("shows malformed JSON as a recoverable source-first error", () => {
    const html = renderToStaticMarkup(
      createElement(VegaLiteChartCard, {
        language: "vega-lite",
        source: '{ "mark": "bar",',
        theme: "dark",
        title: null,
      }),
    );

    expect(html).toContain('aria-label="Vega-Lite chart"');
    expect(html).toContain("Unable to render this chart");
    expect(html).toContain("Invalid JSON at line 1");
    expect(html).toContain("&quot;mark&quot;: &quot;bar&quot;");
  });
});
