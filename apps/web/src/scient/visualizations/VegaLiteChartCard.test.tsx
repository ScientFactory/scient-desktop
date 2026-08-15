// @effect-diagnostics nodeBuiltinImport:off -- Static audit for expanded-view action parity.
import * as NodeFS from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { VegaLiteChartCard } from "./VegaLiteChartCard";

const chartCardSource = NodeFS.readFileSync(
  new URL("./VegaLiteChartCard.tsx", import.meta.url),
  "utf8",
);
const chartDialogSource = NodeFS.readFileSync(
  new URL("./VegaLiteChartDialog.tsx", import.meta.url),
  "utf8",
);

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

  it("discloses viewing-device network resources before the chart loads", () => {
    const html = renderToStaticMarkup(
      createElement(VegaLiteChartCard, {
        language: "vega-lite",
        source: '{"data":{"url":"http://127.0.0.1:8000/results.csv"},"mark":"point"}',
        theme: "light",
        title: null,
      }),
    );

    expect(html).toContain("Network data");
    expect(html).toContain("loads HTTP(S) resources from the viewing device");
    expect(html).toContain("Chart will render when visible");
  });
});

describe("VegaLiteChartDialog expanded actions", () => {
  it("exports from the expanded live controller and retains source actions", () => {
    for (const label of [
      "Copy source",
      "Download Vega-Lite JSON",
      "Download current SVG",
      "Copy current image",
      "Download current PNG",
    ]) {
      expect(chartDialogSource).toContain(label);
    }
    expect(chartDialogSource).toContain("controllerRef.current");
    expect(chartDialogSource).toContain("downloadVegaLiteSvg(controller, exportTitle)");
    expect(chartDialogSource).toContain("downloadVegaLitePng(controller, exportTitle)");
    expect(chartCardSource).toContain("exportTitle={title}");
    expect(chartCardSource).toContain("source={source}");
  });

  it("keeps an open expanded chart mounted while the inline view reloads", () => {
    expect(chartCardSource).toContain("(ready || expanded) && parsedSource.parsed != null");
  });
});
