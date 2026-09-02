import { MermaidDiagramCard } from "../diagrams/MermaidDiagramCard";
import { PlotlyChartCard } from "../visualizations/PlotlyChartCard";
import { VegaLiteChartCard } from "../visualizations/VegaLiteChartCard";

import type { ScientRichFenceAuthoringActions } from "./RichFenceSourceActions";

const SCIENT_RICH_FENCE_RENDERERS = {
  mermaid: MermaidDiagramCard,
  plotly: PlotlyChartCard,
  "vega-lite": VegaLiteChartCard,
} as const;

export type ScientRichFenceKind = keyof typeof SCIENT_RICH_FENCE_RENDERERS;

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

interface ScientRichFenceProps {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly fenceMeta?: string | undefined;
  readonly kind: ScientRichFenceKind;
  readonly language: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly title: string | null;
}

export function resolveScientRichFenceKind(language: string): ScientRichFenceKind | null {
  const normalized = language.trim().toLowerCase();
  return SCIENT_RICH_FENCE_ALIASES[normalized] ?? null;
}

export function ScientRichFence({
  authoringActions,
  fenceMeta,
  kind,
  language,
  source,
  theme,
  title,
}: ScientRichFenceProps) {
  const Renderer = SCIENT_RICH_FENCE_RENDERERS[kind];

  return (
    <Renderer
      authoringActions={authoringActions}
      fenceMeta={fenceMeta}
      language={language}
      source={source}
      theme={theme}
      title={title}
    />
  );
}
