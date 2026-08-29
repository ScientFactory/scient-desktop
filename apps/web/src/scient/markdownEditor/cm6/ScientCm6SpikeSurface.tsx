import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";
import { useEffect, useRef, useState } from "react";

import {
  insertBlockTemplate,
  insertLink,
  toggleLinePrefix,
  toggleNumberedList,
  toggleWrap,
} from "./commands";
import { ScientCm6EditorView } from "./view";

const SAVE_DEBOUNCE_MS = 600;

const CODE_BLOCK_TEMPLATE = "```\n\n```";
const MATH_BLOCK_TEMPLATE = "$$\n\n$$";
const TABLE_TEMPLATE = "| Column | Column |\n| ------ | ------ |\n|        |        |";

interface ToolbarAction {
  readonly label: string;
  readonly run: (view: NonNullable<ScientCm6EditorView["view"]>) => void;
}

const PRIMARY_ACTIONS: ReadonlyArray<ToolbarAction> = [
  { label: "B", run: (view) => void toggleWrap(view, "**") },
  { label: "I", run: (view) => void toggleWrap(view, "*") },
  { label: "S", run: (view) => void toggleWrap(view, "~~") },
  { label: "</>", run: (view) => void toggleWrap(view, "`") },
  { label: "H1", run: (view) => void toggleLinePrefix(view, "# ") },
  { label: "H2", run: (view) => void toggleLinePrefix(view, "## ") },
  { label: "H3", run: (view) => void toggleLinePrefix(view, "### ") },
  { label: "• List", run: (view) => void toggleLinePrefix(view, "- ") },
  { label: "1. List", run: (view) => void toggleNumberedList(view) },
  { label: "☑ Task", run: (view) => void toggleLinePrefix(view, "- [ ] ") },
  { label: "❝ Quote", run: (view) => void toggleLinePrefix(view, "> ") },
  { label: "Link", run: (view) => void insertLink(view) },
];

const OVERFLOW_ACTIONS: ReadonlyArray<ToolbarAction> = [
  { label: "Code block", run: (view) => void insertBlockTemplate(view, CODE_BLOCK_TEMPLATE) },
  { label: "Math block", run: (view) => void insertBlockTemplate(view, MATH_BLOCK_TEMPLATE) },
  { label: "Table", run: (view) => void insertBlockTemplate(view, TABLE_TEMPLATE) },
  {
    label: "Horizontal rule",
    run: (view) => void insertBlockTemplate(view, "\n---\n"),
  },
];

export interface ScientCm6SpikeSurfaceProps {
  readonly source: string;
  readonly revision: string;
  /** Shows or hides the editing controls; the document is always editable. */
  readonly editChrome: boolean;
  readonly ariaLabel: string;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaveConfirmed: (source: string, revision: string) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
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
  const [overflowOpen, setOverflowOpen] = useState(false);

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
        placeholder: "Start writing…",
        ...(props.resolveImageSource ? { resolveImageSource: props.resolveImageSource } : {}),
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

  const runAction = (action: ToolbarAction): void => {
    const view = controller.view;
    if (!view) return;
    action.run(view);
    view.focus();
    setOverflowOpen(false);
  };

  const toolbarButtonStyle: React.CSSProperties = {
    padding: "0.15rem 0.55rem",
    borderRadius: "6px",
    border: "1px solid transparent",
    background: "transparent",
    cursor: "pointer",
    fontSize: "0.8rem",
    minWidth: "1.7rem",
  };

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
        <span style={{ opacity: 0.55, marginLeft: "auto", fontSize: "0.8rem" }}>
          {conflict ? "conflict" : pending ? "saving…" : "saved"}
        </span>
      </div>
      {props.editChrome ? (
        <div
          aria-label="Markdown editing controls"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.15rem",
            padding: "0.3rem 1rem",
            borderBottom: "1px solid color-mix(in srgb, currentColor 10%, transparent)",
          }}
        >
          {PRIMARY_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              aria-label={action.label}
              style={toolbarButtonStyle}
              onClick={() => runAction(action)}
            >
              {action.label}
            </button>
          ))}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              aria-label="More Markdown actions"
              style={toolbarButtonStyle}
              aria-expanded={overflowOpen}
              onClick={() => {
                setOverflowOpen((open) => !open);
              }}
            >
              ⋯
            </button>
            {overflowOpen ? (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  top: "1.9rem",
                  left: 0,
                  zIndex: 20,
                  minWidth: "10rem",
                  padding: "0.3rem",
                  borderRadius: "8px",
                  border: "1px solid color-mix(in srgb, currentColor 15%, transparent)",
                  background: "var(--background, white)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {OVERFLOW_ACTIONS.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    role="menuitem"
                    style={{
                      ...toolbarButtonStyle,
                      textAlign: "left",
                      border: "none",
                      padding: "0.35rem 0.6rem",
                    }}
                    onClick={() => {
                      runAction(action);
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
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
