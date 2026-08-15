import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PlotlyChartCard, plotlySlotStatus } from "./PlotlyChartCard";

describe("PlotlyChartCard server fallback", () => {
  it("keeps valid source canonical before the lazy browser render starts", () => {
    const source = JSON.stringify({
      data: [{ type: "scatter", x: [1, 2], y: [3, 5] }],
      layout: {
        title: { text: "Treatment response" },
        meta: { description: "Response rises between observations." },
      },
    });
    const html = renderToStaticMarkup(
      createElement(PlotlyChartCard, {
        fenceMeta: 'title="response.plotly.json"',
        language: "plotly",
        source,
        theme: "light",
        title: "response.plotly.json",
      }),
    );

    expect(html).toContain('role="figure"');
    expect(html).toContain("response.plotly.json");
    expect(html).toContain("Figure will render when visible");
    expect(html).toContain("Response rises between observations.");
    expect(html).toContain("title=&quot;response.plotly.json&quot;");
    expect(html).not.toContain("js-plotly-plot");
  });

  it("shows malformed JSON as a recoverable source-first error", () => {
    const html = renderToStaticMarkup(
      createElement(PlotlyChartCard, {
        language: "plotly",
        source: '{ "data": [',
        theme: "dark",
        title: null,
      }),
    );

    expect(html).toContain('aria-label="Plotly figure"');
    expect(html).toContain("Unable to render this Plotly figure");
    expect(html).toContain("Invalid JSON at line 1");
    expect(html).toContain("&quot;data&quot;");
  });

  it("gives identical figures independent accessible descriptions", () => {
    const source = JSON.stringify({
      data: [],
      layout: { meta: { description: "An intentionally empty control figure." } },
    });
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(PlotlyChartCard, {
          language: "plotly",
          source,
          theme: "light",
          title: null,
        }),
        createElement(PlotlyChartCard, {
          language: "plotly",
          source,
          theme: "light",
          title: null,
        }),
      ),
    );
    const describedBy = [...html.matchAll(/aria-describedby="([^"]+)"/gu)].map((match) => match[1]);

    expect(describedBy).toHaveLength(2);
    expect(new Set(describedBy).size).toBe(2);
  });
});

describe("PlotlyChartCard WebGL slot status", () => {
  it("turns an evicted ready figure into a waiting state without losing warnings", () => {
    expect(
      plotlySlotStatus(
        { kind: "ready", source: "{}", warnings: ["A compatible warning."] },
        { active: false, expanded: false, hasWebGl: true },
      ),
    ).toEqual({
      kind: "waiting-for-slot",
      source: "{}",
      warnings: ["A compatible warning."],
    });
  });

  it("keeps non-WebGL and expanded figures ready", () => {
    const ready = { kind: "ready" as const, source: "{}", warnings: [] };

    expect(plotlySlotStatus(ready, { active: false, expanded: false, hasWebGl: false })).toBe(
      ready,
    );
    expect(plotlySlotStatus(ready, { active: false, expanded: true, hasWebGl: true })).toBe(ready);
  });
});
