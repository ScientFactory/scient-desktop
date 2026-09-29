import { MermaidDiagramCard } from "../diagrams/MermaidDiagramCard";
import { PlotlyChartCard } from "../visualizations/PlotlyChartCard";
import { VegaLiteChartCard } from "../visualizations/VegaLiteChartCard";

import type { ScientRichFenceKind } from "./scientRichFenceKind";
import type {
  ScientRichFenceAuthoringActions,
  ScientRichFenceSourceEditor,
} from "./RichFenceSourceActions";

const SCIENT_RICH_FENCE_RENDERERS = {
  mermaid: MermaidDiagramCard,
  plotly: PlotlyChartCard,
  "vega-lite": VegaLiteChartCard,
} as const satisfies Record<ScientRichFenceKind, unknown>;

interface ScientRichFenceProps {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly sourceEditor?: ScientRichFenceSourceEditor | undefined;
  readonly fenceMeta?: string | undefined;
  readonly kind: ScientRichFenceKind;
  readonly language: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly title: string | null;
}

export function ScientRichFence({
  authoringActions,
  sourceEditor,
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
      sourceEditor={sourceEditor}
      fenceMeta={fenceMeta}
      language={language}
      source={source}
      theme={theme}
      title={title}
    />
  );
}

export { resolveScientRichFenceKind, type ScientRichFenceKind } from "./scientRichFenceKind";
