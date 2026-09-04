import { useCallback, useEffect, useRef, useState } from "react";

import { renderMermaidDiagram } from "~/scient/diagrams/mermaidRuntime";
import type { ScientRichFenceAuthoringActions } from "~/scient/presentation/RichFenceSourceActions";
import { type ScientRichFenceKind, ScientRichFence } from "~/scient/presentation/ScientRichFence";
import { useNearViewport } from "~/scient/presentation/useNearViewport";
import { parsePlotlySource } from "~/scient/visualizations/plotlySpec";
import { parseVegaLiteSource } from "~/scient/visualizations/vegaLiteSpec";

interface ScientEditableRichFenceProps {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly fenceMeta?: string | undefined;
  readonly kind: ScientRichFenceKind;
  readonly language: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly title: string | null;
}

const MERMAID_VALIDATION_DEBOUNCE_MS = 180;

interface RichFenceValidationRequest {
  readonly generation: number;
  readonly kind: ScientRichFenceKind;
  readonly notBefore: number;
  readonly source: string;
  readonly theme: "light" | "dark";
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
  const validationRunningRef = useRef<RichFenceValidationRequest | null>(null);
  const pendingValidationRef = useRef<RichFenceValidationRequest | null>(null);
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNearViewportRef = useRef(isNearViewport);
  const mountedRef = useRef(true);
  const hasStartedValidationRef = useRef(false);
  const previousInputRef = useRef<{
    readonly isNearViewport: boolean;
    readonly kind: ScientRichFenceKind;
    readonly theme: "light" | "dark";
  } | null>(null);
  const runPendingValidationRef = useRef<() => void>(() => undefined);
  const schedulePendingValidationRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingValidationRef.current = null;
      if (validationTimerRef.current != null) clearTimeout(validationTimerRef.current);
      validationTimerRef.current = null;
    };
  }, []);

  const schedulePendingValidation = useCallback(() => {
    if (validationTimerRef.current != null) {
      clearTimeout(validationTimerRef.current);
      validationTimerRef.current = null;
    }
    if (!mountedRef.current || !isNearViewportRef.current || validationRunningRef.current != null) {
      return;
    }
    const pending = pendingValidationRef.current;
    if (!pending) return;
    const delay = Math.max(0, pending.notBefore - Date.now());
    if (delay === 0) {
      runPendingValidationRef.current();
      return;
    }
    validationTimerRef.current = setTimeout(() => {
      validationTimerRef.current = null;
      runPendingValidationRef.current();
    }, delay);
  }, []);

  const runPendingValidation = useCallback(() => {
    if (!mountedRef.current || !isNearViewportRef.current || validationRunningRef.current != null) {
      return;
    }
    const request = pendingValidationRef.current;
    if (!request) return;
    if (request.notBefore > Date.now()) {
      schedulePendingValidationRef.current();
      return;
    }
    pendingValidationRef.current = null;
    validationRunningRef.current = request;
    hasStartedValidationRef.current = true;
    setValidationState("validating");

    const finish = (succeeded: boolean, cause?: unknown) => {
      validationRunningRef.current = null;
      if (!mountedRef.current) return;
      if (validationGenerationRef.current === request.generation) {
        if (succeeded) {
          hasValidSourceRef.current = true;
          setRenderedSource(request.source);
          setRetainedError(null);
          setValidationState("valid");
        } else {
          if (!hasValidSourceRef.current) setRenderedSource(request.source);
          setRetainedError(hasValidSourceRef.current ? richFenceErrorMessage(cause) : null);
          setValidationState("invalid");
        }
      }
      schedulePendingValidationRef.current();
    };

    void validateRichFence(request.kind, request.source, request.theme).then(
      () => finish(true),
      (cause: unknown) => finish(false, cause),
    );
  }, []);

  runPendingValidationRef.current = runPendingValidation;
  schedulePendingValidationRef.current = schedulePendingValidation;

  useEffect(() => {
    isNearViewportRef.current = isNearViewport;
    const previous = previousInputRef.current;
    const enteredViewport = isNearViewport && previous?.isNearViewport === false;
    const presentationChanged =
      previous != null && (previous.kind !== props.kind || previous.theme !== props.theme);
    previousInputRef.current = {
      isNearViewport,
      kind: props.kind,
      theme: props.theme,
    };
    const generation = validationGenerationRef.current + 1;
    validationGenerationRef.current = generation;
    const shouldDebounce =
      props.kind === "mermaid" &&
      hasStartedValidationRef.current &&
      !enteredViewport &&
      !presentationChanged;
    pendingValidationRef.current = {
      generation,
      kind: props.kind,
      notBefore: Date.now() + (shouldDebounce ? MERMAID_VALIDATION_DEBOUNCE_MS : 0),
      source: props.source,
      theme: props.theme,
    };
    schedulePendingValidation();
  }, [isNearViewport, props.kind, props.source, props.theme, schedulePendingValidation]);

  const isRetained = retainedError !== null;
  return (
    <div
      ref={ref}
      className="scient-markdown-editable-rich-fence"
      data-scient-rich-fence-source-state={isRetained ? "retained" : "current"}
      data-scient-rich-fence-validity={validationState}
    >
      <ScientRichFence
        authoringActions={props.authoringActions}
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
