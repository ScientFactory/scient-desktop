/**
 * Series colours for every chart renderer: Vega-Lite and Plotly use all ten,
 * Mermaid charts (Pele) the first eight, so the same series keeps its colour.
 *
 * Tableau 10 order. Red and green look alike to red-green colour-blind readers,
 * so green comes fifth: the first four, which most charts use, stay distinct.
 */
export const SCIENT_CHART_SERIES_COLORS = [
  "#4c78a8",
  "#f58518",
  "#e45756",
  "#72b7b2",
  "#54a24b",
  "#eeca3b",
  "#b279a2",
  "#ff9da6",
  "#9d755d",
  "#bab0ac",
] as const;
