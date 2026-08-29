import type { MarkdownDocumentMode, MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";
import { useEffect, useRef, useState } from "react";

import { ScientCm6EditorView } from "./view";

const SAVE_DEBOUNCE_MS = 600;

export interface ScientCm6SpikeSurfaceProps {
  readonly source: string;
  readonly revision: string;
  readonly mode: MarkdownDocumentMode;
  readonly ariaLabel: string;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaveConfirmed: (source: string, revision: string) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly onOpenLink?: (target: string) => void;
  readonly resolveImageSource?: (authoredSource: string) => Promise<string | null>;
  readonly saveResolution?: {
    readonly action: "discard" | "retry";
    readonly revision: string;
  } | null;
  readonly onSaveResolutionApplied?: () => void;
}

/**
 * Dev-only spike surface for the CodeMirror live-preview core. Same file,
 * same save lane, same session contract as the ProseMirror surface, so the
 * feel of both can be compared on real documents.
 */
export function ScientCm6SpikeSurface(props: ScientCm6SpikeSurfaceProps) {
  const persistRef = useRef(props.persist);
  const onPendingChangeRef = useRef(props.onPendingChange);
  const onSaveConfirmedRef = useRef(props.onSaveConfirmed);
  const onSaveFailureRef = useRef(props.onSaveFailure);
  persistRef.current = props.persist;
  onPendingChangeRef.current = props.onPendingChange;
  onSaveConfirmedRef.current = props.onSaveConfirmed;
  onSaveFailureRef.current = props.onSaveFailure;

  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ScientCm6EditorView | null>(null);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);

  const [saveQueue] = useState(
    () =>
      new MarkdownSaveQueue({
        debounceMs: SAVE_DEBOUNCE_MS,
        persist: (intent) => persistRef.current(intent),
        onPendingChange: (isPending) => {
          setPending(isPending);
          onPendingChangeRef.current(isPending);
        },
        onConfirmed: (intent, result) => {
          controllerRef.current?.confirmSave(intent, result.revision);
          onSaveConfirmedRef.current(intent.source, result.revision);
        },
        onFailure: (_intent, error) => onSaveFailureRef.current(error),
      }),
  );
  const [controller] = useState(
    () =>
      new ScientCm6EditorView({
        source: props.source,
        revision: props.revision,
        mode: props.mode,
        placeholder: "Start writing…",
        ...(props.resolveImageSource ? { resolveImageSource: props.resolveImageSource } : {}),
        ...(props.onOpenLink ? { onOpenLink: props.onOpenLink } : {}),
        onUserSourceChange: (_source, intent) => {
          saveQueue.enqueue(intent);
        },
      }),
  );
  controllerRef.current = controller;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    controller.mount(element);
    return () => {
      void saveQueue.flush();
    };
  }, [controller, saveQueue]);

  useEffect(() => {
    controller.setMode(props.mode);
  }, [controller, props.mode]);

  useEffect(() => {
    const result = controller.receiveExternalSource({
      source: props.source,
      revision: props.revision,
    });
    if (result === "conflict") {
      saveQueue.pause();
      setConflict(true);
      props.onExternalConflict({ source: props.source, revision: props.revision });
    } else {
      setConflict(false);
    }
  }, [controller, props, saveQueue]);

  useEffect(() => {
    if (!props.saveResolution) return;
    if (props.saveResolution.action === "discard") {
      saveQueue.discard();
      controller.resolveExternalConflict("disk");
    } else {
      controller.resolveExternalConflict("local");
      saveQueue.retry(props.saveResolution.revision);
    }
    setConflict(false);
    props.onSaveResolutionApplied?.();
  }, [controller, props.saveResolution, saveQueue]);

  const startConflictResolution = (action: "discard" | "retry"): void => {
    if (action === "discard") {
      saveQueue.discard();
      controller.resolveExternalConflict("disk");
    } else {
      controller.resolveExternalConflict("local");
      saveQueue.retry();
    }
    setConflict(false);
  };

  const modes: ReadonlyArray<{ readonly value: MarkdownDocumentMode; readonly label: string }> = [
    { value: "read", label: "Read" },
    { value: "write", label: "Write" },
    { value: "source", label: "Source" },
  ];

  return (
    <div
      className="scient-cm6-spike"
      aria-label={props.ariaLabel}
      style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.4rem 1rem",
          borderBottom: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
          fontSize: "0.85rem",
        }}
      >
        <span style={{ opacity: 0.6, fontWeight: 600 }}>CM6 spike</span>
        <div
          role="radiogroup"
          aria-label="Markdown mode"
          style={{ display: "flex", gap: "0.25rem" }}
        >
          {modes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={props.mode === mode.value}
              onClick={() => controller.setMode(mode.value)}
              style={{
                padding: "0.2rem 0.7rem",
                borderRadius: "6px",
                border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
                background:
                  props.mode === mode.value
                    ? "color-mix(in srgb, #3b82f6 18%, transparent)"
                    : "transparent",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span style={{ opacity: 0.55, marginLeft: "auto", fontSize: "0.8rem" }}>
          {conflict ? "conflict" : pending ? "saving…" : "saved"}
        </span>
      </div>
      {conflict ? (
        <div
          role="alert"
          style={{
            padding: "0.5rem 1rem",
            background: "color-mix(in srgb, #f59e0b 15%, transparent)",
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            fontSize: "0.85rem",
          }}
        >
          <span>The file changed on disk while you were editing.</span>
          <button type="button" onClick={() => startConflictResolution("discard")}>
            Reload from disk
          </button>
          <button type="button" onClick={() => startConflictResolution("retry")}>
            Keep mine
          </button>
        </div>
      ) : null}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
