import { use, useCallback, useEffect, useState } from "react";
import { MarkdownFindContext, useFindRevealRef } from "~/components/chat/markdownFindContext";
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
  const searching = use(MarkdownFindContext);
  const [findSourceVisible, setFindSourceVisible] = useState(false);
  const revealSource = useCallback(() => setFindSourceVisible(true), []);
  const sourceRevealRef = useFindRevealRef(revealSource);
  useEffect(() => {
    if (!searching) setFindSourceVisible(false);
  }, [searching]);

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
      {searching ? (
        <pre
          data-scient-rich-fence-find-source
          ref={sourceRevealRef}
          hidden={!findSourceVisible}
          className="scient-mermaid-source my-2 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed"
        >
          <code>{source}</code>
        </pre>
      ) : null}
    </>
  );
}

export { resolveScientRichFenceKind, type ScientRichFenceKind } from "./scientRichFenceKind";
