// @effect-diagnostics nodeBuiltinImport:off -- Static audit of Plotly layout CSS.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const visualizationStyles = NodeFS.readFileSync(
  new URL("./scient-visualizations.css", import.meta.url),
  "utf8",
);

describe("Plotly layout CSS", () => {
  it("does not skip layout of Plotly cards before they enter the viewport", () => {
    const plotlyCard = /\.scient-plotly-card\s*\{(?<rules>[^}]*)\}/u.exec(visualizationStyles)
      ?.groups?.rules;

    expect(visualizationStyles).not.toMatch(
      /\.scient-plotly-card\s*\{[^}]*content-visibility:\s*auto/u,
    );
    expect(plotlyCard ?? "").not.toContain("content-visibility");
  });

  it("forces Plotly to fill height only in the expanded dialog", () => {
    expect(visualizationStyles).toContain(".scient-plotly-view.h-full .svg-container");
    expect(visualizationStyles).not.toMatch(
      /^\.scient-plotly-view \.svg-container\s*\{[^}]*height:\s*100%\s*!important/mu,
    );
  });

  it("keeps the released WebGL stage aligned with the padded inline view", () => {
    expect(visualizationStyles).toMatch(
      /\.scient-plotly-stage\s*\{[^}]*min-height:\s*calc\(20rem \+ 1\.5rem\)/u,
    );
    expect(visualizationStyles).toMatch(
      /@media \(min-width: 40rem\)[\s\S]*?\.scient-plotly-stage\s*\{[^}]*min-height:\s*calc\(20rem \+ 2\.5rem\)/u,
    );
  });

  it("leaves Plotly graph cursors under Plotly's interaction control", () => {
    expect(visualizationStyles).not.toMatch(/\.scient-plotly-graph[^}]*cursor:/u);
    expect(visualizationStyles).toContain(".scient-plotly-view .slider-container");
  });
});
