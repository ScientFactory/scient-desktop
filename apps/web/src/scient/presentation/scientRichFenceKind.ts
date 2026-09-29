/**
 * The rich fence languages Scient renders as visuals, without loading their
 * renderers. Surfaces that only need to classify a fence import this module.
 */
export type ScientRichFenceKind = "mermaid" | "plotly" | "vega-lite";

const SCIENT_RICH_FENCE_ALIASES: Readonly<Record<string, ScientRichFenceKind>> = {
  mermaid: "mermaid",
  plotly: "plotly",
  "plotly.js": "plotly",
  "plotly-json": "plotly",
  plotlyjs: "plotly",
  "vega-lite": "vega-lite",
  vegalite: "vega-lite",
  vl: "vega-lite",
};

export function resolveScientRichFenceKind(language: string): ScientRichFenceKind | null {
  const normalized = language.trim().toLowerCase();
  return SCIENT_RICH_FENCE_ALIASES[normalized] ?? null;
}
