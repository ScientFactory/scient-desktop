import { MermaidDiagramCard } from "../diagrams/MermaidDiagramCard";
import { VegaLiteChartCard } from "../visualizations/VegaLiteChartCard";

export type ScientRichFenceKind = "mermaid" | "vega-lite";

interface ScientRichFenceProps {
  readonly fenceMeta?: string | undefined;
  readonly kind: ScientRichFenceKind;
  readonly language: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly title: string | null;
}

export function resolveScientRichFenceKind(language: string): ScientRichFenceKind | null {
  const normalized = language.trim().toLowerCase();
  if (normalized === "mermaid") return "mermaid";
  if (normalized === "vega-lite" || normalized === "vegalite" || normalized === "vl") {
    return "vega-lite";
  }
  return null;
}

export function ScientRichFence({
  fenceMeta,
  kind,
  language,
  source,
  theme,
  title,
}: ScientRichFenceProps) {
  if (kind === "mermaid") {
    return (
      <MermaidDiagramCard
        fenceMeta={fenceMeta}
        language={language}
        source={source}
        theme={theme}
        title={title}
      />
    );
  }

  return (
    <VegaLiteChartCard
      fenceMeta={fenceMeta}
      language={language}
      source={source}
      theme={theme}
      title={title}
    />
  );
}
