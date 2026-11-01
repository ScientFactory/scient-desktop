// @effect-diagnostics nodeBuiltinImport:off -- Static audit of Plotly layout CSS.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const visualizationStyles = NodeFS.readFileSync(
  new URL("./scient-visualizations.css", import.meta.url),
  "utf8",
);

describe("Plotly layout CSS", () => {
  // Plotly's regl draws into a 0x0 canvas inside a content-visibility:auto subtree
  // (see scient-visualizations.css), so charts render blank.
  it("does not skip layout of Plotly cards before they enter the viewport", () => {
    const plotlyCard = /\.scient-plotly-card\s*\{(?<rules>[^}]*)\}/u.exec(visualizationStyles)
      ?.groups?.rules;

    expect(visualizationStyles).not.toMatch(
      /\.scient-plotly-card\s*\{[^}]*content-visibility:\s*auto/u,
    );
    expect(plotlyCard ?? "").not.toContain("content-visibility");
  });
});
