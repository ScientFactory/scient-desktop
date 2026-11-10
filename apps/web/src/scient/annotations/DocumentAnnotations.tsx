import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  Highlighter,
  MessageSquare,
  SquareDashed,
  Trash2,
  X,
  ArrowLeft,
  Undo2,
} from "lucide-react";
import type {
  AnnotationCapture,
  AnnotationCommand,
  AnnotationRecord,
} from "@scientfactory/annotations";
import type {
  AnnotationDocumentRequest,
  AnnotationDocumentResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { observeSelectionActions } from "../../lib/selectionActions";
import { randomUUID } from "../../lib/utils";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";
import {
  beginPdfAreaSelection,
  captureSelectedPdfPassage,
  readPassageMaterial,
  readPdfPassageSelection,
  showCapturedPdfPassage,
  verifyCapturedPdfPassage,
  type PdfPassageSelectionResult,
} from "../pdf/passages/pdfPassageCapture";
import { PASSAGE_REFUSAL_COPY } from "../pdf/passages/pdfPassageModel";
import { copySourceExcerpt, sourceExcerptCopy } from "../sources/sourceExcerptCopy";
import { readScientSource } from "../sources/client";
import { createDocumentNoteSession, readDocumentNoteDraft } from "./annotationDraft";
import {
  annotationMaterial,
  mutateAnnotation,
  openAnnotations,
  prepareAnnotations,
} from "./client";
import "./annotationReader.css";

export interface DocumentAnnotationsProps extends AnnotationDocumentRequest {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly runtime: ScientPdfRuntime | null;
  readonly onAskScient?: (context: string) => boolean;
  readonly onOpenAnnotatedVersion?: (input: {
    workspaceRoot: string;
    relativePath: string;
    annotationId: string;
    resourceId: string;
  }) => void;
}

export function DocumentAnnotations(props: DocumentAnnotationsProps) {
  return (
    <LoadDocumentAnnotations
      key={JSON.stringify([props.environmentId, props.root, props.target])}
      {...props}
    />
  );
}
function LoadDocumentAnnotations(props: DocumentAnnotationsProps) {
  const [state, setState] = useState<AnnotationDocumentResult | null>(null);
  const [failed, setFailed] = useState(false);
  const targetKey = JSON.stringify(props.target);
  useEffect(() => {
    let cancelled = false;
    // The request key prevents old-target state from being rendered during a context change.
    void openAnnotations(props.environmentId, {
      root: props.root,
      target: JSON.parse(targetKey),
    }).then(
      (result) => {
        if (!cancelled) setState(result);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.root, targetKey]);
  if (failed)
    return (
      <span role="status" className="text-xs text-muted-foreground">
        Annotations unavailable
      </span>
    );
  if (!state) return null;
  if (!state.enabled || !state.binding) return null;
  return (
    <AnnotationReader
      key={JSON.stringify([props.environmentId, props.root, targetKey, state.binding])}
      {...props}
      initial={state}
    />
  );
}

type Reference = Parameters<typeof sourceExcerptCopy>[0];
type NoteCommand = Exclude<AnnotationCommand, { action: "remove" | "restore" }>;
const capturePages = (capture: AnnotationCapture) =>
  capture.pages.map((page) => ({
    page: page.page,
    quote: "quote" in page ? page.quote : "",
  }));
const captureQuote = (capture: AnnotationCapture) =>
  capturePages(capture)
    .map((p) => p.quote)
    .join("\n\n");
const activeDrafts = new Set<string>();

export function AnnotationReader(
  props: DocumentAnnotationsProps & { initial: AnnotationDocumentResult },
) {
  const [documentState, setDocumentState] = useState(props.initial);
  const [reference, setReference] = useState<Reference>({
    title: props.title,
    creators: [],
    issuedYear: null,
    identifiers: [],
    url: null,
  });
  const [selection, setSelection] = useState<PdfPassageSelectionResult>({ _tag: "Empty" });
  const [panel, setPanel] = useState<"list" | "selection" | "note" | "saved" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [needsAnchor, setNeedsAnchor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<AnnotationRecord | null>(null);
  const [anchor, setAnchor] = useState({ x: 16, y: 100 });
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const editing = useRef(false);
  const running = useRef(false);
  const uncertain = useRef(new Map<string, AnnotationCommand>());
  const pendingHighlight = useRef<Extract<AnnotationCommand, { action: "create" }> | null>(null);
  const areaCleanup = useRef<(() => void) | null>(null);
  const session = useRef<ReturnType<typeof createDocumentNoteSession> | null>(null);
  const currentState = useRef(documentState);
  const dismiss = useRef<() => void>(() => {});
  const [editorId] = useState(randomUUID);
  const draftPrefix =
    JSON.stringify([
      "scient-document-note-v1",
      props.environmentId,
      props.root,
      props.target,
      props.initial.binding,
    ]) + ":";
  const draftKey = useRef(draftPrefix + editorId);
  const recovered = useRef(false);
  const recoveredOrigin = useRef<{ key: string; raw: string } | null>(null);
  useLayoutEffect(() => {
    currentState.current = documentState;
    editing.current = panel === "note";
  }, [documentState, panel]);

  useEffect(() => {
    alive.current = true;
    activeDrafts.add(draftKey.current);
    const key = draftKey.current;
    return () => {
      alive.current = false;
      areaCleanup.current?.();
      void Promise.resolve(session.current?.leave()).finally(() => activeDrafts.delete(key));
    };
  }, []);
  useEffect(() => {
    if (props.target.kind !== "source") return;
    let cancelled = false;
    void readScientSource(props.environmentId, {
      root: props.root,
      sourceId: props.target.sourceId,
    })
      .then((record) => {
        if (!cancelled && record) setReference(record);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.root, props.target]);

  function accept(record: AnnotationRecord) {
    if (!alive.current) return;
    setDocumentState((previous) => {
      const known = previous.annotations.find((r) => r.annotationId === record.annotationId);
      if (known && known.revision > record.revision) return previous;
      return {
        ...previous,
        annotations: [
          ...previous.annotations.filter((r) => r.annotationId !== record.annotationId),
          record,
        ],
      };
    });
  }
  async function mutate(command: AnnotationCommand) {
    const binding = currentState.current.binding;
    if (!binding) throw new Error("Reopen this document before saving.");
    const { operationId: _operation, ...meaning } = command;
    const key = JSON.stringify(meaning);
    const intent = uncertain.current.get(key) ?? command;
    uncertain.current.set(key, intent);
    const result = await mutateAnnotation(props.environmentId, {
      root: props.root,
      target: props.target,
      binding,
      command: intent,
    });
    uncertain.current.delete(key);
    if (result.outcome === "conflict") {
      if (result.record) accept(result.record);
      throw new Error(
        "This annotation changed elsewhere. Your draft is kept; reopen the latest note before replacing it.",
      );
    }
    if (!result.record) throw new Error("This annotation is unavailable. Your draft is kept.");
    accept(result.record);
    return result.record;
  }
  async function prepare() {
    const binding = currentState.current.binding;
    if (!binding) throw new Error("Reopen this document before saving.");
    const result = await prepareAnnotations(props.environmentId, {
      root: props.root,
      target: props.target,
      binding,
    });
    if (alive.current) setDocumentState(result);
    currentState.current = result;
    return result.resource?.resourceId ?? null;
  }
  async function run(operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "This action could not be completed. Your note is kept.",
        );
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function startNote(
    command: NoteCommand | undefined,
    value: string,
    baseline = "",
    attempt = false,
  ) {
    setNote(value);
    setPanel("note");
    setError("");
    setNeedsAnchor(!command);
    setSelected(command?.action === "edit" ? command.annotationId : null);
    const next = createDocumentNoteSession({
      key: draftKey.current,
      note: value,
      ...(command ? { command } : {}),
      baseline,
      attempt,
      save: mutate,
      onBusy: (value) => {
        if (alive.current) setBusy(value);
      },
      onError: (message) => {
        if (alive.current) setError(message);
      },
      onSaved: (record, latest) => {
        clearRecoveredOrigin();
        if (!alive.current || session.current !== next) return;
        accept(record);
        setSelected(record.annotationId);
        setNote(latest);
        setError("");
      },
    });
    session.current = next;
    return next;
  }
  function clearRecoveredOrigin() {
    const origin = recoveredOrigin.current;
    if (!origin) return;
    try {
      // Never erase edits made by a different window since recovery.
      if (localStorage.getItem(origin.key) === origin.raw) localStorage.removeItem(origin.key);
      recoveredOrigin.current = null;
    } catch {
      /* The acknowledged canonical record remains authoritative. */
    }
  }
  async function closeNote() {
    const active = session.current;
    if (!active) return;
    if ((await active.leave()) && alive.current && session.current === active) {
      active.discard();
      session.current = null;
      setPanel(null);
      setError("");
    }
  }
  useLayoutEffect(() => {
    dismiss.current = () => {
      if (editing.current) void closeNote();
      else {
        setPanel(null);
        setSelection({ _tag: "Empty" });
      }
    };
  });
  useEffect(() => {
    if (recovered.current) return;
    recovered.current = true;
    // Each live editor owns a different key. Recovery is copied, never overwritten by another editor.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(draftPrefix) || activeDrafts.has(key)) continue;
        const recoveredDraft = readDocumentNoteDraft(key);
        const command = recoveredDraft?.command;
        if (
          !recoveredDraft ||
          (!command && !recoveredDraft.note.trim()) ||
          (command && !(command.action === "create" || command.action === "edit"))
        )
          continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        recoveredOrigin.current = { key, raw };
        // oxlint-disable-next-line react/set-state-in-effect -- Recover the external browser draft journal, once per context.
        startNote(command, recoveredDraft.note, "", recoveredDraft.attempt);
        setError(
          command
            ? "Recovered an unsaved draft. Review it before saving."
            : "Your draft is kept. Select its area in the PDF before saving.",
        );
        break;
      }
    } catch {
      /* Storage may be unavailable; normal saves remain usable. */
    }
  }, [draftPrefix]);

  useEffect(() => {
    const runtime = props.runtime;
    if (!runtime) return;
    const observer = observeSelectionActions({
      element: runtime.viewer.container,
      getActionElement: () => popup.current,
      onSelection: (pointer) => {
        if (editing.current || running.current || areaCleanup.current) return;
        const dom = window.getSelection();
        const result = readPdfPassageSelection(runtime, dom);
        pendingHighlight.current = null;
        setSelection(result);
        if (result._tag === "Empty") {
          setPanel(null);
          return;
        }
        const bounds = dom?.rangeCount ? dom.getRangeAt(0).getBoundingClientRect() : null;
        setAnchor({
          x: pointer?.x ?? bounds?.left ?? 16,
          y: (pointer?.y ?? bounds?.bottom ?? 80) + 8,
        });
        setPanel("selection");
        setError("");
      },
      onDismiss: () => {
        if (!editing.current && !running.current) {
          setPanel(null);
          setSelection({ _tag: "Empty" });
        }
      },
    });
    const selectionChanged = () => observer.selectionChanged();
    document.addEventListener("selectionchange", selectionChanged);
    return () => {
      observer.dispose();
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, [props.runtime]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        dismiss.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss.current();
      if (
        event.key === "Tab" &&
        panel === "selection" &&
        !popup.current?.contains(document.activeElement)
      ) {
        const first = popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    };
  }, [panel]);

  useEffect(() => {
    const runtime = props.runtime;
    if (!runtime || !documentState.annotations.some((record) => !record.deletedAt)) return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    void readPassageMaterial(runtime)
      .then((material) => {
        if (cancelled) return;
        for (const record of documentState.annotations) {
          if (
            record.deletedAt ||
            record.region.capture.material.sha256 !== material.sha256 ||
            record.region.capture.material.byteLength !== material.byteLength
          )
            continue;
          cleanups.push(
            showCapturedPdfPassage(runtime, record.region.capture, {
              navigate: false,
              highlighted: record.highlighted,
              label: record.note ? "Open note" : "Open highlight",
              onActivate: (bounds) => {
                if (editing.current || running.current) return;
                setAnchor({ x: bounds.right + 8, y: bounds.top });
                setSelected(record.annotationId);
                setPanel("saved");
                setError("");
              },
            }),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      cleanups.forEach((clean) => clean());
    };
  }, [props.runtime, documentState.annotations]);

  const active = documentState.annotations
    .filter((r) => !r.deletedAt)
    .toSorted(
      (a, b) =>
        a.region.capture.pages[0]!.page - b.region.capture.pages[0]!.page ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const selectedRecord = active.find((r) => r.annotationId === selected);
  async function saveCapture(
    capture: AnnotationCapture,
    highlight: boolean,
    draftSession?: ReturnType<typeof createDocumentNoteSession>,
  ) {
    const activeSession = highlight ? null : (draftSession ?? startNote(undefined, ""));
    const resourceId = await prepare();
    if (!resourceId) throw new Error("Open a PDF before adding an annotation.");
    const command: NoteCommand = (highlight ? pendingHighlight.current : null) ?? {
      action: "create",
      operationId: randomUUID(),
      annotationId: randomUUID(),
      resourceId,
      capture,
      note: "",
      highlighted: highlight,
    };
    if (highlight) {
      if (!alive.current) return;
      pendingHighlight.current = command;
      await mutate(command);
      setPanel(null);
      window.getSelection()?.removeAllRanges();
      pendingHighlight.current = null;
    } else {
      activeSession!.prepare(command);
      if (alive.current) setNeedsAnchor(false);
    }
  }
  function selectArea() {
    if (!props.runtime) return;
    const pendingNote = panel === "note" ? session.current : null;
    setPanel(null);
    areaCleanup.current?.();
    areaCleanup.current = beginPdfAreaSelection(
      props.runtime,
      (capture) => {
        areaCleanup.current = null;
        if (pendingNote) setPanel("note");
        void run(() => saveCapture(capture, false, pendingNote ?? undefined));
      },
      () => {
        areaCleanup.current = null;
        if (pendingNote) setPanel("note");
      },
      (message) => {
        areaCleanup.current = null;
        setError(message);
        setPanel("list");
      },
    );
  }
  const textPages =
    selection._tag === "Ready"
      ? selection.pages.map((p) => ({ page: p.page, quote: p.text.slice(p.start, p.end) }))
      : [];
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="scient-pdf-toolbar-button"
        aria-label="Annotations"
        aria-expanded={panel === "list"}
        onClick={() => {
          if (editing.current) {
            void closeNote();
            return;
          }
          const bounds = trigger.current!.getBoundingClientRect();
          setAnchor({ x: bounds.right - 320, y: bounds.bottom + 8 });
          setPanel(panel === "list" ? null : "list");
          setError("");
        }}
      >
        <MessageSquare />
        {active.length ? <span className="text-xs">{active.length}</span> : null}
      </button>
      {panel
        ? createPortal(
            <div
              ref={popup}
              role="dialog"
              aria-label="Annotations"
              className={
                "scient-annotation-popover" +
                (panel === "selection" ? " scient-annotation-selection" : "")
              }
              style={{
                left: Math.max(
                  8,
                  Math.min(anchor.x, window.innerWidth - (panel === "selection" ? 456 : 344)),
                ),
                top: Math.max(
                  8,
                  Math.min(anchor.y, window.innerHeight - (panel === "selection" ? 96 : 260)),
                ),
                maxHeight: "min(420px, calc(100vh - 16px))",
              }}
              onBlur={(event) => {
                if (
                  editing.current &&
                  !event.currentTarget.contains(event.relatedTarget as Node | null)
                )
                  void closeNote();
              }}
            >
              {panel === "selection" && selection._tag === "Ready" ? (
                <div
                  role="toolbar"
                  aria-label="Selected text actions"
                  className="flex flex-wrap items-center gap-0.5"
                  onPointerDown={(event) => event.preventDefault()}
                >
                  {([true, false] as const).map((highlight) => (
                    <Button
                      key={String(highlight)}
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (!props.runtime || selection._tag !== "Ready") return;
                          const draftSession = highlight ? undefined : startNote(undefined, "");
                          const result = await captureSelectedPdfPassage(
                            props.runtime,
                            selection.pages,
                          );
                          if (result._tag === "Refused")
                            throw new Error(PASSAGE_REFUSAL_COPY[result.reason]);
                          await saveCapture(result.capture, highlight, draftSession);
                        })
                      }
                    >
                      {highlight ? <Highlighter /> : <MessageSquare />}
                      {highlight ? "Highlight" : "Note"}
                    </Button>
                  ))}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void run(async () => {
                        await writeTextToClipboard(
                          textPages.map((p) => p.quote).join("\n\n"),
                          "PDF excerpt",
                        );
                        setPanel(null);
                      })
                    }
                  >
                    <Copy />
                    Copy
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void run(async () => {
                        await copySourceExcerpt(sourceExcerptCopy(reference, textPages));
                        setPanel(null);
                      })
                    }
                  >
                    Cite
                  </Button>
                  {props.onAskScient ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        if (
                          props.onAskScient?.(
                            "PDF excerpt:\n" +
                              sourceExcerptCopy(reference, textPages).markdown +
                              "\n\n",
                          )
                        )
                          setPanel(null);
                      }}
                    >
                      <MessageSquare />
                      Add to chat
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {panel === "selection" && selection._tag === "Refused" ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {PASSAGE_REFUSAL_COPY[selection.reason]}
                  </p>
                  <Button size="xs" variant="ghost" onClick={selectArea}>
                    <SquareDashed />
                    Select area instead
                  </Button>
                </>
              ) : null}
              {panel === "note" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void closeNote();
                  }}
                >
                  {needsAnchor ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || !props.runtime}
                      onClick={selectArea}
                    >
                      <SquareDashed />
                      Select area for this note
                    </Button>
                  ) : null}
                  <textarea
                    autoFocus
                    aria-label="Annotation note"
                    dir="auto"
                    placeholder="Write a note…"
                    rows={2}
                    className="min-h-14 w-full resize-y border-0 bg-transparent px-1 py-2 text-sm outline-none"
                    maxLength={8000}
                    value={note}
                    onChange={(event) => {
                      setNote(event.target.value);
                      session.current?.change(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
                        event.currentTarget.form?.requestSubmit();
                    }}
                  />
                  <div className="flex justify-end gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        session.current?.discard();
                        clearRecoveredOrigin();
                        session.current = null;
                        setPanel(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      type="submit"
                      disabled={busy || (!note.trim() && !selectedRecord?.highlighted)}
                    >
                      Save
                    </Button>
                  </div>
                </form>
              ) : null}
              {panel === "list" || panel === "saved" ? (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Annotations</span>
                  <div className="flex gap-1">
                    {panel === "saved" ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="All annotations"
                        onClick={() => setPanel("list")}
                      >
                        <ArrowLeft />
                      </Button>
                    ) : null}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Close annotations"
                      onClick={() => setPanel(null)}
                    >
                      <X />
                    </Button>
                  </div>
                </div>
              ) : null}
              {panel === "list" ? (
                <>
                  {documentState.needsMigration ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await prepare();
                        })
                      }
                    >
                      Import existing annotations
                    </Button>
                  ) : null}
                  {active.length ? (
                    active.map((record) => (
                      <button
                        key={record.annotationId}
                        type="button"
                        className="block w-full rounded-md px-2 py-2 text-start hover:bg-muted/50"
                        onClick={() => {
                          setSelected(record.annotationId);
                          setPanel("saved");
                        }}
                      >
                        <span className="block text-xs text-muted-foreground">
                          Page {record.region.capture.pages.map((p) => p.page).join(", ")}
                        </span>
                        <span dir="auto" className="line-clamp-2 text-sm">
                          {record.note || captureQuote(record.region.capture) || "Marked area"}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="py-2 text-sm text-muted-foreground">
                      Select text to highlight it or add a note.
                    </p>
                  )}
                  {props.runtime ? (
                    <Button size="xs" variant="ghost" onClick={selectArea}>
                      <SquareDashed />
                      Select area
                    </Button>
                  ) : null}
                </>
              ) : null}
              {panel === "saved" && selectedRecord ? (
                <>
                  {props.onOpenAnnotatedVersion ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const binding = currentState.current.binding;
                          if (!binding) throw new Error("Reopen this document first.");
                          const asset = await annotationMaterial(props.environmentId, {
                            root: props.root,
                            binding,
                            annotationId: selectedRecord.annotationId,
                          });
                          props.onOpenAnnotatedVersion?.({
                            ...asset,
                            annotationId: selectedRecord.annotationId,
                            resourceId: selectedRecord.region.resourceId,
                          });
                          setPanel(null);
                        })
                      }
                    >
                      Open annotated version
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!props.runtime || busy}
                    onClick={() =>
                      void run(async () => {
                        if (!props.runtime) return;
                        const verified = await verifyCapturedPdfPassage(
                          props.runtime,
                          selectedRecord.region.capture,
                        );
                        if (verified._tag !== "Exact")
                          throw new Error(PASSAGE_REFUSAL_COPY[verified.reason]);
                        // Navigation is synchronous; the persistent annotation layer already owns the mark.
                        showCapturedPdfPassage(props.runtime, selectedRecord.region.capture, {
                          highlighted: selectedRecord.highlighted,
                        })();
                      })
                    }
                  >
                    Go to page {selectedRecord.region.capture.pages.map((p) => p.page).join(", ")}
                  </Button>
                  {selectedRecord.note ? (
                    <p dir="auto" className="my-2 whitespace-pre-wrap text-sm">
                      {selectedRecord.note}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        startNote(
                          {
                            action: "edit",
                            operationId: randomUUID(),
                            annotationId: selectedRecord.annotationId,
                            expectedRevision: selectedRecord.revision,
                            note: selectedRecord.note,
                            highlighted: selectedRecord.highlighted,
                          },
                          selectedRecord.note,
                          selectedRecord.note,
                        )
                      }
                    >
                      Edit note
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (selectedRecord.highlighted && !selectedRecord.note.trim()) {
                            const removed = await mutate({
                              action: "remove",
                              operationId: randomUUID(),
                              annotationId: selectedRecord.annotationId,
                              expectedRevision: selectedRecord.revision,
                            });
                            setUndo(removed);
                            setPanel("list");
                          } else
                            await mutate({
                              action: "edit",
                              operationId: randomUUID(),
                              annotationId: selectedRecord.annotationId,
                              expectedRevision: selectedRecord.revision,
                              note: selectedRecord.note,
                              highlighted: !selectedRecord.highlighted,
                            });
                        })
                      }
                    >
                      {selectedRecord.highlighted ? "Remove highlight" : "Highlight"}
                    </Button>
                    {captureQuote(selectedRecord.region.capture) ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void run(async () => {
                            await copySourceExcerpt(
                              sourceExcerptCopy(
                                reference,
                                capturePages(selectedRecord.region.capture),
                              ),
                            );
                          })
                        }
                      >
                        Cite
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const removed = await mutate({
                            action: "remove",
                            operationId: randomUUID(),
                            annotationId: selectedRecord.annotationId,
                            expectedRevision: selectedRecord.revision,
                          });
                          setUndo(removed);
                          setPanel("list");
                        })
                      }
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                </>
              ) : null}
              {undo ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await mutate({
                        action: "restore",
                        operationId: randomUUID(),
                        annotationId: undo.annotationId,
                        expectedRevision: undo.revision,
                      });
                      setUndo(null);
                    })
                  }
                >
                  <Undo2 />
                  Undo removal
                </Button>
              ) : null}
              {error ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}
              {busy ? (
                <span role="status" className="sr-only">
                  Saving
                </span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
