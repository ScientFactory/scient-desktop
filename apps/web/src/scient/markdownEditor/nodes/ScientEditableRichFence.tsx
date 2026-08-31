import { useEffect, useRef, useState } from "react";

import { renderMermaidDiagram } from "~/scient/diagrams/mermaidRuntime";
import { type ScientRichFenceKind, ScientRichFence } from "~/scient/presentation/ScientRichFence";
import { useNearViewport } from "~/scient/presentation/useNearViewport";
import { parsePlotlySource } from "~/scient/visualizations/plotlySpec";
import { parseVegaLiteSource } from "~/scient/visualizations/vegaLiteSpec";

interface ScientEditableRichFenceProps {
  readonly fenceMeta?: string | undefined;
  readonly kind: ScientRichFenceKind;
  readonly language: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly title: string | null;
}

function richFenceErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "The current source cannot be rendered yet.";
}

async function validateRichFence(
  kind: ScientRichFenceKind,
  source: string,
  theme: "light" | "dark",
): Promise<void> {
  switch (kind) {
    case "mermaid":
      await renderMermaidDiagram(source, theme);
      return;
    case "plotly":
      parsePlotlySource(source);
      return;
    case "vega-lite":
      parseVegaLiteSource(source);
      return;
  }
}

/**
 * Keeps the last renderable scientific fence mounted while the author is in
 * an invalid intermediate state. The Markdown node and nested source editor
 * always retain the current source; only the visual projection is retained.
 */
export function ScientEditableRichFence(props: ScientEditableRichFenceProps) {
  const { ref, isNearViewport } = useNearViewport();
  const [renderedSource, setRenderedSource] = useState(props.source);
  const [retainedError, setRetainedError] = useState<string | null>(null);
  const [validationState, setValidationState] = useState<"invalid" | "valid" | "validating">(
    "validating",
  );
  const hasValidSourceRef = useRef(false);
  const validationGenerationRef = useRef(0);

  useEffect(() => {
    // Mermaid validation renders the diagram, so it must not bypass the card's
    // viewport gate when a document contains many unvisited scientific fences.
    if (!isNearViewport) return;
    const generation = validationGenerationRef.current + 1;
    validationGenerationRef.current = generation;
    let active = true;
    setValidationState("validating");

    void validateRichFence(props.kind, props.source, props.theme).then(
      () => {
        if (!active || validationGenerationRef.current !== generation) return;
        hasValidSourceRef.current = true;
        setRenderedSource(props.source);
        setRetainedError(null);
        setValidationState("valid");
      },
      (cause: unknown) => {
        if (!active || validationGenerationRef.current !== generation) return;
        if (!hasValidSourceRef.current) setRenderedSource(props.source);
        setRetainedError(hasValidSourceRef.current ? richFenceErrorMessage(cause) : null);
        setValidationState("invalid");
      },
    );

    return () => {
      active = false;
    };
  }, [isNearViewport, props.kind, props.source, props.theme]);

  const isRetained = retainedError !== null;
  return (
    <div
      ref={ref}
      className="scient-markdown-editable-rich-fence"
      data-scient-rich-fence-source-state={isRetained ? "retained" : "current"}
      data-scient-rich-fence-validity={validationState}
    >
      <ScientRichFence
        kind={props.kind}
        language={props.language}
        source={renderedSource}
        theme={props.theme}
        title={props.title}
        {...(props.fenceMeta ? { fenceMeta: props.fenceMeta } : {})}
      />
      {isRetained ? (
        <div className="scient-markdown-rich-fence-retained" role="status">
          <strong>Preview kept at the last valid version.</strong>
          <span>{retainedError}</span>
        </div>
      ) : null}
    </div>
  );
}
