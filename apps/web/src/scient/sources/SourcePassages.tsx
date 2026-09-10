import {
  activeSourcePassages,
  type ScientSavedPassage,
  type ScientPassageCommand,
} from "@scientfactory/scient-sources";
import type { EnvironmentId, ScientSourceDetailResult } from "@t3tools/contracts";
import {
  Highlighter,
  MessageSquare,
  Copy,
  Pencil,
  Trash2,
  X,
  ArrowLeft,
  ChevronDown,
} from "lucide-react";
import { createPortal } from "react-dom";
import { observeSelectionActions } from "../../lib/selectionActions";
import "./sourceAnnotations.css";
import { copySourceExcerpt, sourceExcerptCopy } from "./sourceExcerptCopy";
import { createAnnotationNoteSession, readAnnotationNoteDraft } from "./annotationNoteDraft";
import { randomUUID } from "../../lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";
import {
  captureSelectedPdfPassage,
  readPassageMaterial,
  readPdfPassageSelection,
  showCapturedPdfPassage,
  verifyCapturedPdfPassage,
  type PdfPassageSelectionResult,
} from "../pdf/passages/pdfPassageCapture";
import { PASSAGE_REFUSAL_COPY } from "../pdf/passages/pdfPassageModel";
import { mutateScientSourcePassage, readScientSource } from "./client";

export interface SourcePassageContext {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId?: string;
  readonly onAskScient?: (context: string) => boolean;
}

export function SourcePassages(
  props: SourcePassageContext & {
    readonly runtime: ScientPdfRuntime | null;
    readonly onRecordChange?: (record: ScientSourceDetailResult) => void;
  },
) {
  const [record, setRecord] = useState<ScientSourceDetailResult | null>(null);
  const [copyOptions, setCopyOptions] = useState(false);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 16, y: 100 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newNote, setNewNote] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const draftActive = useRef(false);
  const [selection, setSelection] = useState<PdfPassageSelectionResult>({ _tag: "Empty" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<{ passage: ScientSavedPassage; note: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    draftActive.current = newNote !== null || editing !== null;
  }, [newNote, editing]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const operation = useRef(false);
  const clearMarks = useRef<(() => void) | null>(null);
  // A failed/uncertain save retries the same ID, not a duplicate capture.
  const [retrySave, setRetrySave] = useState<Extract<
    ScientPassageCommand,
    { action: "save" }
  > | null>(null);
  const noteSession = useRef<ReturnType<typeof createAnnotationNoteSession> | null>(null);
  const mounted = useRef(true);
  const leaveNote = useRef<() => void>(() => {});
  const draftKey = JSON.stringify([
    "scient-annotation-note-v1",
    props.environmentId,
    props.root,
    props.sourceId,
    props.attachmentId ?? "details",
  ]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void noteSession.current?.leave();
    };
  }, []);

  function beginNote(
    note: string,
    command?: Exclude<ScientPassageCommand, { action: "remove" }>,
    baseline = "",
    attempt = false,
  ) {
    const session = createAnnotationNoteSession({
      key: draftKey,
      note,
      baseline,
      attempt,
      ...(command ? { command } : {}),
      save: async (nextCommand) => {
        if (!record) throw new Error("The source is not ready. Your draft is kept.");
        const result = await mutateScientSourcePassage(props.environmentId, {
          root: props.root,
          projectId: record.projectId,
          sourceId: props.sourceId,
          command: nextCommand,
        });
        if (
          result.outcome === "stale" &&
          !(
            nextCommand.action === "update" &&
            result.passage?.note === nextCommand.note &&
            result.passage.revision === nextCommand.expectedRevision + 1
          )
        ) {
          if (mounted.current && noteSession.current === session) setReload((value) => value + 1);
          throw new Error(
            "This note changed elsewhere. Your draft is kept; copy it before cancelling and reopening the latest note.",
          );
        }
        if (
          !result.passage ||
          result.passage.deletedAt ||
          ["not-found", "material-changed", "limit-reached"].includes(result.outcome)
        )
          throw new Error(
            "The note could not be saved to this source. Your draft is kept; check the source and try again.",
          );
        return result.passage;
      },
      onBusy: (value) => {
        if (mounted.current && noteSession.current === session) setBusy(value);
      },
      onError: (value) => {
        if (mounted.current && noteSession.current === session) {
          setError(true);
          setMessage(value + " Try again using Save note.");
        }
      },
      onSaved: (passage, latestNote) => {
        if (!mounted.current || noteSession.current !== session) return;
        setRecord((previous) =>
          previous
            ? {
                ...previous,
                savedPassages: [
                  ...(previous.savedPassages ?? []).filter(
                    (item) => item.passageId !== passage.passageId,
                  ),
                  passage,
                ],
              }
            : previous,
        );
        setSelection({ _tag: "Empty" });
        setSelectedId(passage.passageId);
        if (!command || command.action === "save") {
          setNewNote(latestNote);
        } else {
          setOpen(true);
          setEditing({ passage, note: latestNote });
        }
        setError(false);
        setMessage("");
        void readScientSource(props.environmentId, { root: props.root, sourceId: props.sourceId })
          .then((next) => {
            if (mounted.current && noteSession.current === session) props.onRecordChange?.(next);
          })
          .catch(() => {});
      },
    });
    noteSession.current = session;
    return session;
  }

  async function saveNoteAndClose() {
    const session = noteSession.current;
    if (!session) return;
    if (await session.leave()) {
      if (mounted.current && noteSession.current === session) {
        session.discard();
        noteSession.current = null;
        close(true);
      }
    }
  }
  useLayoutEffect(() => {
    leaveNote.current = () => {
      void saveNoteAndClose();
    };
  });

  const recovered = useRef(false);
  useEffect(() => {
    if (!record || recovered.current) return;
    recovered.current = true;
    const draft = readAnnotationNoteDraft(draftKey);
    if (!draft?.note) return;
    const command = draft.command;
    if (command?.action === "update") {
      const passage = record.savedPassages?.find((item) => item.passageId === command.passageId);
      if (passage) {
        // Synchronize the editor with a schema-checked external recovery draft.
        // oxlint-disable-next-line react/set-state-in-effect
        setEditing({
          passage: { ...passage, revision: command.expectedRevision },
          note: draft.note,
        });
        setSelectedId(passage.passageId);
        setOpen(true);
      } else setNewNote(draft.note);
    } else setNewNote(draft.note);
    beginNote(draft.note, command?.action !== "remove" ? command : undefined, "", draft.attempt);
    setMessage(
      command
        ? "Recovered your unsaved note. Review it, then save."
        : "Recovered your text, but not its PDF location. Copy it before cancelling and selecting the passage again.",
    );
    // Recovery runs once per mounted source editor, never over an active draft.
  }, [record, draftKey]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (
        operation.current ||
        popupRef.current?.contains(event.target as Node) ||
        triggerRef.current?.contains(event.target as Node)
      )
        return;
      if (draftActive.current) {
        leaveNote.current();
        return;
      }
      setOpen(false);
      setMessage("");
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && draftActive.current) {
        leaveNote.current();
        return;
      }
      if (event.key === "Escape" && !draftActive.current && !operation.current) {
        setOpen(false);
        setSelection({ _tag: "Empty" });
        setMessage("");
      }
      if (
        event.key === "Tab" &&
        selection._tag !== "Empty" &&
        !popupRef.current?.contains(document.activeElement)
      ) {
        const first = popupRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [selection._tag]);

  useEffect(() => {
    let current = true;
    void readScientSource(props.environmentId, { root: props.root, sourceId: props.sourceId }).then(
      (next) => {
        if (current) setRecord(next);
      },
      () => {
        if (current) {
          setError(true);
          setMessage("Saved passages could not be loaded. Try again.");
        }
      },
    );
    return () => {
      current = false;
    };
    // Explicit retry/conflict reloads re-read the same source identity.
  }, [props.environmentId, props.root, props.sourceId, reload]);

  useEffect(() => {
    generation.current += 1;
    operation.current = false;
    // The PDF runtime is an external resource; replacement cancels its in-flight UI work.
    // oxlint-disable-next-line react/set-state-in-effect
    setBusy(false);
    setSelection({ _tag: "Empty" });
    clearMarks.current?.();
    clearMarks.current = null;
    const runtime = props.runtime;
    const changed = () => observer?.selectionChanged();
    const observer = runtime
      ? observeSelectionActions({
          element: runtime.viewer.container,
          getActionElement: () => popupRef.current,
          onSelection: (pointer) => {
            if (draftActive.current || operation.current) return;
            try {
              const domSelection = window.getSelection();
              const next = readPdfPassageSelection(runtime, domSelection);
              const rect = domSelection?.rangeCount
                ? domSelection.getRangeAt(0).getBoundingClientRect()
                : null;
              setSelection(next);
              if (next._tag !== "Empty") {
                setAnchor({
                  x: pointer?.x ?? rect?.left ?? 16,
                  y: (pointer?.y ?? rect?.bottom ?? 80) + 8,
                });
                setOpen(false);
                setSelectedId(null);
                setRetrySave(null);
                setCopyOptions(false);
                setMessage("");
              }
            } catch {
              setSelection({ _tag: "Refused", reason: "invalid-selection" });
            }
          },
          onDismiss: () => {
            if (!draftActive.current && !operation.current) setSelection({ _tag: "Empty" });
          },
        })
      : null;
    if (runtime) document.addEventListener("selectionchange", changed);
    return () => {
      generation.current += 1;
      observer?.dispose();
      document.removeEventListener("selectionchange", changed);
      clearMarks.current?.();
      clearMarks.current = null;
    };
  }, [props.runtime]);

  useEffect(() => {
    const runtime = props.runtime;
    if (!runtime || !record || !props.attachmentId) return;
    const saved = activeSourcePassages(record).filter(
      (passage) => passage.attachmentId === props.attachmentId,
    );
    if (!saved.length) return;
    let disposed = false;
    const cleaners: Array<() => void> = [];
    // Hash once per runtime. Never draw saved locations on replacement material.
    void readPassageMaterial(runtime)
      .then((material) => {
        if (disposed) return;
        for (const passage of saved) {
          if (
            passage.attachmentId !== props.attachmentId ||
            passage.capture.material.sha256 !== material.sha256 ||
            passage.capture.material.byteLength !== material.byteLength
          )
            continue;
          cleaners.push(
            showCapturedPdfPassage(runtime, passage.capture, {
              navigate: false,
              highlighted: passage.highlighted ?? passage.note.length === 0,
              label: passage.note
                ? "Open annotation: " + passage.note.slice(0, 80)
                : "Open highlight",
              onActivate: (bounds) => {
                if (draftActive.current || operation.current) return;
                setSelection({ _tag: "Empty" });
                setAnchor({ x: bounds.right + 8, y: bounds.top });
                setSelectedId(passage.passageId);
                setOpen(true);
                setMessage("");
              },
            }),
          );
        }
      })
      .catch(() => {
        // Saved notes remain available in the list even when location checks fail.
      });
    return () => {
      disposed = true;
      for (const clean of cleaners) clean();
    };
  }, [props.runtime, record, props.attachmentId]);

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    const job = ++generation.current;
    const current = () => job === generation.current;
    setBusy(true);
    setError(false);
    setMessage("");
    try {
      await action(current);
    } catch {
      if (current()) {
        setError(true);
        setMessage(
          "The action could not be completed. Your saved passages and unsaved note have been kept. Try again.",
        );
      }
    } finally {
      if (current()) {
        operation.current = false;
        setBusy(false);
      }
    }
  }

  async function mutate(command: ScientPassageCommand, current: () => boolean) {
    if (!record) return;
    const result = await mutateScientSourcePassage(props.environmentId, {
      root: props.root,
      projectId: record.projectId,
      sourceId: props.sourceId,
      command,
    });
    if (!current()) return;
    if (result.outcome === "stale") {
      setError(true);
      setMessage(
        "This passage changed elsewhere. Your draft is kept. Cancel to load the latest note, then edit again.",
      );
      setReload((value) => value + 1);
      return;
    }
    if (["not-found", "material-changed", "limit-reached"].includes(result.outcome)) {
      setRetrySave(null);
      setError(true);
      setMessage(
        result.outcome === "material-changed"
          ? "The source PDF changed or was detached. Reopen it before saving."
          : result.outcome === "limit-reached"
            ? "This source has reached the saved-passage count or storage limit. Existing passages are safe; try a shorter note if you are editing."
            : "This passage is no longer available. Reload to see the current source.",
      );
      return;
    }
    const passage = result.passage;
    if (passage)
      setRecord((previous) =>
        previous
          ? {
              ...previous,
              savedPassages: [
                ...(previous.savedPassages ?? []).filter(
                  (item) => item.passageId !== passage.passageId,
                ),
                passage,
              ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
            }
          : previous,
      );
    setRetrySave(null);
    if (command.action === "save") {
      setNewNote(null);
      setSelection({ _tag: "Empty" });
      window.getSelection()?.removeAllRanges();
      setOpen(false);
    }
    if (command.action === "remove") setSelectedId(null);
    if (command.action === "remove") {
      clearMarks.current?.();
      clearMarks.current = null;
    }
    setEditing((draft) => (draft?.passage.passageId === command.passageId ? null : draft));
    setRemoving(null);
    setMessage(
      command.action === "remove"
        ? "Passage removed."
        : passage?.deletedAt
          ? "This passage was already removed; it has not been restored."
          : "Saved to this project.",
    );
    // Keep the owning Sources cache at the same revision without dropping other drafts.
    try {
      const refreshed = await readScientSource(props.environmentId, {
        root: props.root,
        sourceId: props.sourceId,
      });
      if (current()) {
        setRecord(refreshed);
        props.onRecordChange?.(refreshed);
      }
    } catch {
      if (current())
        setMessage(
          "Saved. The source could not be refreshed yet; reopen it to fetch the latest revision.",
        );
    }
  }

  const passages = record
    ? activeSourcePassages(record).filter(
        (item) => !props.attachmentId || item.attachmentId === props.attachmentId,
      )
    : [];
  const orderedPassages = passages.toSorted(
    (a, b) =>
      a.capture.pages[0]!.page - b.capture.pages[0]!.page ||
      a.capture.pages[0]!.start - b.capture.pages[0]!.start ||
      a.createdAt.localeCompare(b.createdAt),
  );

  function close(saved = false) {
    if (busy && !saved) return;
    if (!saved) noteSession.current?.discard();
    noteSession.current = null;
    setOpen(false);
    setSelection({ _tag: "Empty" });
    setNewNote(null);
    setRetrySave(null);
    setEditing(null);
    setRemoving(null);
    setMessage("");
    triggerRef.current?.focus();
  }

  async function capture(current: () => boolean) {
    if (retrySave) return retrySave;
    if (!props.runtime || !props.attachmentId || selection._tag !== "Ready") return null;
    const result = await captureSelectedPdfPassage(props.runtime, selection.pages);
    if (!current()) return null;
    if (result._tag === "Refused") {
      setError(true);
      setMessage(PASSAGE_REFUSAL_COPY[result.reason]);
      return null;
    }
    const command = {
      action: "save",
      passageId: randomUUID(),
      attachmentId: props.attachmentId,
      capture: result.capture,
      note: "",
    } as const;
    setRetrySave(command);
    return command;
  }

  const selectedText =
    selection._tag === "Ready"
      ? selection.pages.map((page) => page.text.slice(page.start, page.end)).join("\n\n")
      : "";
  const showPopup = open || selection._tag !== "Empty" || newNote !== null || (!!message && error);
  const selectionMenu = !open && newNote === null && selection._tag === "Ready";
  const panel = (
    <div
      ref={popupRef}
      className={
        props.attachmentId
          ? `scient-annotation-popover${selectionMenu ? " scient-annotation-selection" : ""}`
          : "text-sm"
      }
      style={
        props.attachmentId
          ? {
              left: Math.max(
                8,
                Math.min(anchor.x, window.innerWidth - (selectionMenu ? 456 : 360)),
              ),
              top: Math.max(
                8,
                Math.min(anchor.y, window.innerHeight - (open || newNote !== null ? 360 : 100)),
              ),
              maxHeight: "min(420px, calc(100vh - 16px))",
            }
          : undefined
      }
      role={props.attachmentId ? "dialog" : "region"}
      aria-label="Annotations"
      onBlur={(event) => {
        if (
          draftActive.current &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        )
          leaveNote.current();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          // Escape dismisses transient actions, but never silently throws away a note.
          if (newNote === null && !editing) close();
        }
      }}
    >
      {open && newNote === null && !editing && (
        <div className="flex items-center justify-between gap-2 pb-2">
          <span className="text-xs font-medium text-muted-foreground">
            {newNote !== null ? "Add note" : selectedId ? "Annotation" : "Annotations"}
          </span>
          <div className="flex gap-1">
            {selectedId && !editing ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="All annotations"
                onClick={() => setSelectedId(null)}
              >
                <ArrowLeft />
              </Button>
            ) : null}
            {newNote === null && !editing ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close annotations"
                disabled={busy}
                onClick={() => close()}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {!open && newNote === null && selection._tag === "Ready" ? (
        <div
          className="flex flex-wrap items-center gap-0.5"
          role="toolbar"
          aria-label="Selected text actions"
          onPointerDown={(event) => event.preventDefault()}
        >
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !record}
            onClick={() =>
              void run(async (current) => {
                const command = await capture(current);
                if (command && current()) await mutate(command, current);
              })
            }
          >
            <Highlighter />
            Highlight
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !record}
            onClick={() => {
              setNewNote("");
              setSelectedId(null);
              const session = beginNote("");
              const runtime = props.runtime;
              const attachmentId = props.attachmentId;
              if (runtime && attachmentId && selection._tag === "Ready")
                void captureSelectedPdfPassage(runtime, selection.pages)
                  .then((result) => {
                    if (result._tag === "Captured")
                      session.prepare({
                        action: "save",
                        passageId: randomUUID(),
                        attachmentId,
                        capture: result.capture,
                        note: "",
                        highlighted: false,
                      });
                    else if (mounted.current) {
                      setError(true);
                      setMessage(PASSAGE_REFUSAL_COPY[result.reason]);
                    }
                  })
                  .catch(() => {
                    if (mounted.current) {
                      setError(true);
                      setMessage(
                        "Could not capture this location. Your note text is kept locally.",
                      );
                    }
                  });
            }}
          >
            <MessageSquare />
            Add note
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async (current) => {
                await writeTextToClipboard(selectedText, "selection");
                if (current()) {
                  setSelection({ _tag: "Empty" });
                  setMessage("Copied.");
                }
              })
            }
          >
            <Copy />
            Copy
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="More copy options"
            aria-expanded={copyOptions}
            disabled={busy}
            onClick={() => setCopyOptions((value) => !value)}
          >
            <ChevronDown />
          </Button>
          {props.onAskScient ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !record}
              onClick={() =>
                void run(async (current) => {
                  if (!record || selection._tag !== "Ready") return;
                  const pages = selection.pages.map((page) => ({
                    page: page.page,
                    quote: page.text.slice(page.start, page.end),
                  }));
                  const context = sourceExcerptCopy(record, pages).markdown;
                  if (!current()) return;
                  if (props.onAskScient?.("PDF excerpt:\n" + context + "\n\n")) {
                    setSelection({ _tag: "Empty" });
                    window.getSelection()?.removeAllRanges();
                  } else {
                    setError(true);
                    setMessage("The message composer is not ready. Try again.");
                  }
                })
              }
            >
              <MessageSquare />
              Add to chat
            </Button>
          ) : null}
        </div>
      ) : null}
      {selectionMenu && copyOptions ? (
        <div className="mt-1 border-t border-border pt-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !record}
            onClick={() =>
              void run(async (current) => {
                if (!record || selection._tag !== "Ready") return;
                const pages = selection.pages.map((page) => ({
                  page: page.page,
                  quote: page.text.slice(page.start, page.end),
                }));
                await copySourceExcerpt(sourceExcerptCopy(record, pages));
                if (current()) {
                  setSelection({ _tag: "Empty" });
                  setCopyOptions(false);
                }
              })
            }
          >
            <Copy />
            Copy with citation
          </Button>
        </div>
      ) : null}
      {newNote !== null ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveNoteAndClose();
          }}
        >
          <textarea
            autoFocus
            aria-label="Annotation note"
            placeholder="Write a note…"
            dir="auto"
            value={newNote}
            maxLength={8000}
            onChange={(event) => {
              setNewNote(event.target.value);
              noteSession.current?.change(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                event.currentTarget.form?.requestSubmit();
            }}
            rows={2}
            className="min-h-14 w-full resize-y border-0 bg-transparent px-1 py-2 text-sm outline-none"
          />
          <div className="mt-1 flex justify-end gap-1">
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => close()}>
              Cancel
            </Button>
            <Button size="xs" variant="ghost" type="submit" disabled={busy || !newNote.trim()}>
              Save note
            </Button>
          </div>
        </form>
      ) : null}
      {message ? (
        <p
          className={`mt-2 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
          role={error ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
      {busy && newNote === null && !editing ? (
        <p className="text-xs text-muted-foreground" role="status">
          Working…
        </p>
      ) : null}
      {selection._tag === "Refused" ? (
        <p className="text-xs text-muted-foreground">{PASSAGE_REFUSAL_COPY[selection.reason]}</p>
      ) : null}
      {open && !record ? (
        <Button size="xs" variant="ghost" onClick={() => setReload((value) => value + 1)}>
          Try again
        </Button>
      ) : null}
      {open && record && !passages.length ? (
        <p className="py-3 text-sm text-muted-foreground">
          Select text in the PDF to highlight it or add a note.
        </p>
      ) : null}
      {open && props.attachmentId && !selectedId ? (
        <div className="divide-y divide-border">
          {orderedPassages.map((passage) => (
            <button
              type="button"
              key={passage.passageId}
              className="block w-full cursor-pointer rounded-md px-2 py-3 text-start hover:bg-muted/50"
              onClick={() => {
                setSelectedId(passage.passageId);
                setMessage("");
              }}
            >
              <span className="mb-1 block text-xs text-muted-foreground">
                Page {passage.capture.pages.map((page) => page.page).join(", ")}
              </span>
              <span dir="auto" className="line-clamp-2 text-sm">
                {passage.note || passage.capture.pages.map((page) => page.quote).join(" ")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <>
          {passages
            .filter((passage) => !props.attachmentId || selectedId === passage.passageId)
            .map((passage) => (
              <article key={passage.passageId} className="py-2">
                {editing?.passage.passageId !== passage.passageId ? (
                  <>
                    <button
                      type="button"
                      className="cursor-pointer text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
                      disabled={busy || !props.runtime}
                      onClick={() =>
                        void run(async (current) => {
                          const runtime = props.runtime;
                          if (!runtime) return;
                          const verification = await verifyCapturedPdfPassage(
                            runtime,
                            passage.capture,
                          );
                          if (!current()) return;
                          clearMarks.current?.();
                          clearMarks.current = null;
                          if (
                            verification._tag === "Exact" ||
                            verification.reason === "extractor-changed"
                          ) {
                            clearMarks.current = showCapturedPdfPassage(runtime, passage.capture, {
                              highlighted: passage.highlighted ?? passage.note.length === 0,
                            });
                            setMessage(
                              verification._tag === "Exact"
                                ? ""
                                : "Showing the saved location in the same PDF. The text extractor changed; compare the quotation with the page.",
                            );
                          } else {
                            setError(true);
                            setMessage(PASSAGE_REFUSAL_COPY[verification.reason]);
                          }
                        })
                      }
                    >
                      Go to PDF page {passage.capture.pages.map((page) => page.page).join(", ")}
                    </button>
                    <blockquote
                      dir="auto"
                      className="my-2 max-h-32 overflow-auto whitespace-pre-wrap border-s-2 border-border ps-3 text-sm leading-relaxed"
                    >
                      {passage.capture.pages.map((page) => page.quote).join("\n\n")}
                    </blockquote>
                  </>
                ) : null}
                {editing?.passage.passageId === passage.passageId ? (
                  <div>
                    <textarea
                      autoFocus
                      dir="auto"
                      aria-label="Passage note"
                      maxLength={8_000}
                      value={editing.note}
                      rows={2}
                      className="min-h-14 w-full resize-y border-0 bg-transparent px-1 py-2 text-sm outline-none"
                      onChange={(event) => {
                        setEditing({ ...editing, note: event.target.value });
                        noteSession.current?.change(event.target.value);
                      }}
                    />
                    <div className="mt-1 flex justify-end gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void saveNoteAndClose()}
                      >
                        Save note
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          noteSession.current?.discard();
                          noteSession.current = null;
                          setEditing(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : passage.note ? (
                  <p dir="auto" className="mb-2 whitespace-pre-wrap text-sm">
                    {passage.note}
                  </p>
                ) : null}
                {editing?.passage.passageId !== passage.passageId ? (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || editing !== null}
                      onClick={() => {
                        setEditing({ passage, note: passage.note });
                        beginNote(
                          passage.note,
                          {
                            action: "update",
                            passageId: passage.passageId,
                            expectedRevision: passage.revision,
                            note: passage.note,
                          },
                          passage.note,
                        );
                      }}
                    >
                      <Pencil />
                      {passage.note ? "Edit note" : "Add note"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async (current) => {
                          if (!record) return;
                          if (!current()) return;
                          await copySourceExcerpt(sourceExcerptCopy(record, passage.capture.pages));
                          if (current()) setMessage("Copied with citation.");
                        })
                      }
                    >
                      <Copy />
                      Copy with citation
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRemoving(passage.passageId)}
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                ) : null}
                {removing === passage.passageId ? (
                  <div className="mt-2 text-xs" role="group" aria-label="Confirm passage removal">
                    <p>Remove this saved passage and its note? The PDF stays in Sources.</p>
                    <div className="mt-1 flex gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run((current) =>
                            mutate(
                              {
                                action: "remove",
                                passageId: passage.passageId,
                                expectedRevision: passage.revision,
                              },
                              current,
                            ),
                          )
                        }
                      >
                        Remove passage
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setRemoving(null)}
                      >
                        Keep passage
                      </Button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
        </>
      ) : null}
    </div>
  );
  return (
    <section className="relative" aria-label="PDF annotations">
      <Button
        ref={triggerRef}
        size="xs"
        variant="ghost"
        aria-expanded={open}
        aria-label={`Annotations (${passages.length})`}
        onClick={() => {
          if (draftActive.current) return;
          const bounds = triggerRef.current?.getBoundingClientRect();
          if (bounds) setAnchor({ x: bounds.right - 344, y: bounds.bottom + 6 });
          setSelection({ _tag: "Empty" });
          setSelectedId(null);
          setOpen((value) => !value);
        }}
      >
        <MessageSquare />
        <span>Annotations{record ? ` (${passages.length})` : ""}</span>
      </Button>
      {props.attachmentId
        ? showPopup
          ? createPortal(panel, document.body)
          : null
        : open
          ? panel
          : null}
    </section>
  );
}
