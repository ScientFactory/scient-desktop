import { use, useState } from "react";
import { MarkdownFindContext, findRevealRef } from "~/components/chat/markdownFindContext";
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

/** Mounted only during Find, so closing it resets transient reveal state by unmounting. */
function ScientRichFenceFindSource({ source }: { readonly source: string }) {
  const [visible, setVisible] = useState(false);
  const revealRef = findRevealRef(() => setVisible(true));
  return (
    <pre
      data-scient-rich-fence-find-source
      ref={revealRef}
      hidden={!visible}
      className="scient-mermaid-source my-2 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed"
    >
      <code>{source}</code>
    </pre>
  );
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
  const searching = use(MarkdownFindContext);

  return (
    <>
      <div data-thread-find-ignore={searching ? "true" : undefined}>
        <Renderer
          authoringActions={authoringActions}
          sourceEditor={sourceEditor}
          fenceMeta={fenceMeta}
          language={language}
          source={source}
          theme={theme}
          title={title}
        />
      </div>
      {searching ? <ScientRichFenceFindSource source={source} /> : null}
    </>
  );
}

export { resolveScientRichFenceKind, type ScientRichFenceKind } from "./scientRichFenceKind";
