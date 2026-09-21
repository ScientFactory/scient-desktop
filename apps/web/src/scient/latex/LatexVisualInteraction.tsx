import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PdfInteractionHost } from "~/scient/pdf/ScientPdfReader";
import { editVisualRun, type VisualRun } from "@t3tools/shared/latexVisual";
import { rebaseVisualMatch, sourceChange, type SourceChange } from "./visualEditingSession";
import {
  createVisualEditManifest,
  visualManifestOffset,
  type VisualEditManifest,
} from "./visualEditManifest";
import {
  measureDraftGeometry,
  visualTextHit,
  type DraftAnchor,
  type DraftGeometry,
} from "./visualPageGeometry";
import {
  checkpointVisualDraft,
  clearUncheckpointedVisualDraft,
  clearVisualDraft,
  readVisualDraft,
  reconcileVisualDraft,
  retainVisualDraft,
} from "./visualDrafts";
import { captureVisualPresentationAnchor } from "./visualPresentationAnchor";

/** Source is checkpointed while typing, but typesetting remains held until the session ends. */
export const VISUAL_SOURCE_CHECKPOINT_DELAY_MS = 700;

interface ActiveEdit {
  readonly baseSource: string;
  readonly presentationRevisionId: string;
  readonly run: VisualRun;
  source: string;
  text: string;
  readonly presentedText: string;
}

interface CompletedEditAnchor {
  readonly presentationRevisionId: string;
  readonly source: string;
  readonly presentedText: string;
  readonly text: string;
}

interface MappingSession {
  readonly revisionId: string;
  readonly baseSource: string;
  currentSource: string;
  readonly changes: SourceChange[];
}

interface InstalledManifest {
  readonly container: HTMLElement;
  readonly revisionId: string;
  readonly value: VisualEditManifest;
}

export interface LatexVisualInteractionProps {
  readonly draftKey: string;
  readonly host: PdfInteractionHost;
  readonly source: string;
  /** Last disk-confirmed file revision, distinct from the optimistic source buffer. */
  readonly fileRevision: string;
  /**
   * Base identity owned by the shared save transaction. It remains pinned when
   * an intermediate save confirms, and advances only when that confirmation
   * completed the pending transaction.
   */
  readonly getDraftBaseRevision: () => string;
  readonly sourceRevision: string | null;
  readonly ready: boolean;
  readonly revisionId: string | null;
  /** Compare-and-set against the shared editor buffer, not just its last saved disk revision. */
  readonly onEdit: (expected: string, next: string) => boolean;
  readonly onEditingChange: (editing: boolean) => void;
  /** Gives the owning mode switch an explicit, synchronous transaction boundary. */
  readonly registerFinishEditing?: (finish: (() => void) | null) => void;
}

export function LatexVisualInteraction(props: LatexVisualInteractionProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const active = useRef<ActiveEdit | null>(null);
  const completedAnchor = useRef<CompletedEditAnchor | null>(null);
  const mapping = useRef<MappingSession | null>(null);
  const manifest = useRef<InstalledManifest | null>(null);
  const draftAnchor = useRef<DraftAnchor | null>(null);
  const composing = useRef(false);
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(props);
  const [sourceHash, setSourceHash] = useState<{ source: string; hash: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const [recovery, setRecovery] = useState<string | null>(() =>
    readVisualDraft(props.draftKey, { source: props.source, revision: props.fileRevision }),
  );
  const recoveryRef = useRef(recovery);
  const [draftGeometry, setDraftGeometry] = useState<DraftGeometry | null>(null);

  useLayoutEffect(() => {
    latest.current = props;
    recoveryRef.current = recovery;
  });

  useEffect(() => {
    if (!globalThis.crypto?.subtle) {
      return;
    }
    let current = true;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(props.source))
      .then((bytes) => {
        if (!current) return;
        setSourceHash({
          source: props.source,
          hash: `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        });
      })
      .catch(() => {
        if (current) setSourceHash(null);
      });
    return () => {
      current = false;
    };
  }, [props.source]);

  const exactlyCurrent =
    props.host.revisionId === props.revisionId &&
    (props.host.rotation ?? 0) === 0 &&
    props.ready &&
    props.host.ready &&
    sourceHash?.source === props.source &&
    sourceHash.hash === props.sourceRevision;
  const clearCheckpointTimer = useCallback(() => {
    if (checkpointTimer.current === null) return;
    clearTimeout(checkpointTimer.current);
    checkpointTimer.current = null;
  }, []);

  const retainTransactionDraft = useCallback((transaction: ActiveEdit, text: string) => {
    const source = editVisualRun(transaction.baseSource, transaction.run, text);
    retainVisualDraft(latest.current.draftKey, {
      text,
      source,
      baseSource: transaction.baseSource,
      baseRevision: latest.current.getDraftBaseRevision(),
    });
    return source;
  }, []);

  const preserveForRecovery = useCallback(
    (transaction: ActiveEdit, text: string) => {
      setRecovery(retainTransactionDraft(transaction, text));
    },
    [retainTransactionDraft],
  );

  const changeEditing = useCallback((next: boolean) => {
    if (editingRef.current === next) return;
    editingRef.current = next;
    // Publication and build holds close synchronously with the click that
    // creates the overlay; a passive effect is too late for a prepared PDF
    // that may be crossing its paint fence in the same turn.
    latest.current.onEditingChange(next);
    setEditing(next);
  }, []);

  const closeEditor = useCallback(() => {
    clearCheckpointTimer();
    active.current = null;
    draftAnchor.current = null;
    setDraftGeometry(null);
    changeEditing(false);
  }, [changeEditing, clearCheckpointTimer]);

  const retainCompletedAnchor = useCallback((transaction: ActiveEdit) => {
    if (transaction.presentedText === transaction.text) return;
    completedAnchor.current = {
      presentationRevisionId: transaction.presentationRevisionId,
      source: transaction.source,
      presentedText: transaction.presentedText,
      text: transaction.text,
    };
  }, []);

  const checkpoint = useCallback((): boolean => {
    clearCheckpointTimer();
    const transaction = active.current;
    const textarea = input.current;
    if (!transaction || !textarea || composing.current) return transaction !== null;
    transaction.text = textarea.value;
    const next = editVisualRun(transaction.baseSource, transaction.run, transaction.text);
    retainVisualDraft(latest.current.draftKey, {
      text: transaction.text,
      source: next,
      baseSource: transaction.baseSource,
      baseRevision: latest.current.getDraftBaseRevision(),
    });
    if (next === transaction.source) {
      clearUncheckpointedVisualDraft(latest.current.draftKey, transaction.source);
      return true;
    }
    const session = mapping.current;
    if (session === null || session.currentSource !== transaction.source) {
      preserveForRecovery(transaction, transaction.text);
      closeEditor();
      return false;
    }
    if (!latest.current.onEdit(transaction.source, next)) {
      preserveForRecovery(transaction, transaction.text);
      closeEditor();
      return false;
    }
    session.changes.push(sourceChange(transaction.source, next));
    session.currentSource = next;
    checkpointVisualDraft(
      latest.current.draftKey,
      transaction.text,
      transaction.source,
      next,
      latest.current.getDraftBaseRevision(),
    );
    transaction.source = next;
    return true;
  }, [clearCheckpointTimer, closeEditor, preserveForRecovery]);

  const scheduleCheckpoint = useCallback(() => {
    clearCheckpointTimer();
    if (composing.current) return;
    checkpointTimer.current = setTimeout(() => {
      checkpointTimer.current = null;
      checkpoint();
    }, VISUAL_SOURCE_CHECKPOINT_DELAY_MS);
  }, [checkpoint, clearCheckpointTimer]);

  const finishEditing = useCallback(() => {
    if (active.current !== null && composing.current) {
      preserveForRecovery(active.current, input.current?.value ?? active.current.text);
      closeEditor();
      return;
    }
    const transaction = active.current;
    if (transaction !== null && checkpoint()) retainCompletedAnchor(transaction);
    closeEditor();
  }, [checkpoint, closeEditor, preserveForRecovery, retainCompletedAnchor]);

  useLayoutEffect(() => {
    props.registerFinishEditing?.(finishEditing);
    return () => props.registerFinishEditing?.(null);
  }, [finishEditing, props.registerFinishEditing]);

  // An update not produced by this session invalidates its positional proof.
  // The user's draft remains recoverable and the stale PDF simply becomes read-only.
  useEffect(() => {
    if (completedAnchor.current?.source !== props.source) completedAnchor.current = null;
    if (active.current && active.current.source !== props.source) {
      const draft = input.current?.value ?? active.current.text;
      if (draft !== active.current.run.text) preserveForRecovery(active.current, draft);
      closeEditor();
      mapping.current = null;
      manifest.current?.value.dispose();
      manifest.current = null;
    } else if (mapping.current && mapping.current.currentSource !== props.source) {
      completedAnchor.current = null;
      mapping.current = null;
      manifest.current?.value.dispose();
      manifest.current = null;
    }
  }, [closeEditor, preserveForRecovery, props.source]);

  // The old page owns the completed transaction until the reader atomically
  // publishes its successor. Candidate staging captures the anchor before this
  // host identity changes; failed or cancelled candidates leave it available
  // for the next exact retry.
  useLayoutEffect(() => {
    if (
      completedAnchor.current !== null &&
      props.host.revisionId !== null &&
      completedAnchor.current.presentationRevisionId !== props.host.revisionId
    ) {
      completedAnchor.current = null;
    }
  }, [props.host.revisionId]);

  // A recovery notice can become obsolete after a successful save/reload while
  // this component remains mounted. Re-evaluate only outside an active edit;
  // active checkpoints already own the optimistic source transition.
  useEffect(() => {
    if (active.current !== null) return;
    const next = reconcileVisualDraft(props.draftKey, {
      source: props.source,
      revision: props.fileRevision,
    });
    if (next !== recoveryRef.current) setRecovery(next);
  }, [props.draftKey, props.fileRevision, props.source]);

  useLayoutEffect(() => {
    const container = props.host.container;
    if (!container) return;
    let disposed = false;
    // A mapping is admitted once per actually presented PDF revision. Local
    // checkpoints then rebase through it until the replacement is published.
    if (
      exactlyCurrent &&
      props.revisionId !== null &&
      mapping.current?.revisionId !== props.revisionId
    ) {
      mapping.current = {
        revisionId: props.revisionId,
        baseSource: props.source,
        currentSource: props.source,
        changes: [],
      };
    }
    let queued = false;
    const rebuild = () => {
      queued = false;
      if (disposed || latest.current.host.container !== container) return;
      const session = mapping.current;
      if (
        session === null ||
        session.revisionId !== latest.current.host.revisionId ||
        (latest.current.host.rotation ?? 0) !== 0
      )
        return;
      const value = createVisualEditManifest(container, session.baseSource);
      if (disposed || latest.current.host.container !== container) {
        value.dispose();
        return;
      }
      manifest.current?.value.dispose();
      manifest.current = {
        container,
        revisionId: session.revisionId,
        value,
      };
    };
    const queueRebuild = () => {
      if (disposed || queued) return;
      queued = true;
      queueMicrotask(rebuild);
    };
    rebuild();
    // PDF.js virtualizes pages and populates text layers after its document
    // ready event. Mapping happens at population time, never after a click.
    const observer = new MutationObserver(queueRebuild);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      disposed = true;
      observer.disconnect();
      if (
        manifest.current?.container === container &&
        manifest.current.revisionId === props.host.revisionId
      ) {
        manifest.current.value.dispose();
        manifest.current = null;
      }
    };
  }, [exactlyCurrent, props.host.container, props.host.revisionId, props.revisionId, props.source]);

  useEffect(() => {
    const container = props.host.container;
    if (!container) return;
    const click = (event: MouseEvent) => {
      const installed = manifest.current;
      const session = mapping.current;
      const current = latest.current;
      if (
        !installed ||
        !session ||
        installed.revisionId !== session.revisionId ||
        !current.host.ready ||
        (current.host.rotation ?? 0) !== 0 ||
        session.revisionId !== current.host.revisionId ||
        session.currentSource !== current.source ||
        recoveryRef.current !== null
      )
        return;
      const hit = visualTextHit(event, container, installed.value);
      if (!hit) return;
      const pageElement = hit.span.closest<HTMLElement>(".page[data-page-number]");
      if (!pageElement) return;

      const selection = document.getSelection();
      const endpoints =
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode instanceof Text &&
        selection.focusNode instanceof Text &&
        container.contains(selection.anchorNode) &&
        container.contains(selection.focusNode)
          ? {
              anchor: installed.value.entryFor(selection.anchorNode.parentElement!),
              anchorOffset: selection.anchorOffset,
              focus: installed.value.entryFor(selection.focusNode.parentElement!),
              focusOffset: selection.focusOffset,
            }
          : null;

      if (active.current !== null) {
        const previous = active.current;
        if (!checkpoint()) return;
        retainCompletedAnchor(previous);
      }
      const currentSource = session.currentSource;
      const baseMatch = {
        run: hit.entry.run,
        offset: visualManifestOffset(hit.entry, hit.offset),
      };
      const match = rebaseVisualMatch(baseMatch, currentSource, session.changes);
      if (!match) return;

      let start = match.offset;
      let end = match.offset;
      if (endpoints?.anchor && endpoints.focus) {
        const anchor = rebaseVisualMatch(
          {
            run: endpoints.anchor.run,
            offset: visualManifestOffset(endpoints.anchor, endpoints.anchorOffset),
          },
          currentSource,
          session.changes,
        );
        const focus = rebaseVisualMatch(
          {
            run: endpoints.focus.run,
            offset: visualManifestOffset(endpoints.focus, endpoints.focusOffset),
          },
          currentSource,
          session.changes,
        );
        if (
          !anchor ||
          !focus ||
          anchor.run.from !== match.run.from ||
          focus.run.from !== match.run.from
        )
          return;
        start = Math.min(anchor.offset, focus.offset);
        end = Math.max(anchor.offset, focus.offset);
      }

      const textarea = input.current;
      if (!textarea) return;
      active.current = {
        baseSource: currentSource,
        presentationRevisionId: session.revisionId,
        source: currentSource,
        run: match.run,
        text: match.run.text,
        presentedText: match.run.text,
      };
      draftAnchor.current = { span: hit.span, page: pageElement, run: hit.entry.run };
      setDraftGeometry(measureDraftGeometry(container, draftAnchor.current, installed.value));
      textarea.value = match.run.text;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, end);
      changeEditing(true);
    };
    container.addEventListener("click", click);
    return () => container.removeEventListener("click", click);
  }, [changeEditing, checkpoint, props.host.container, retainCompletedAnchor]);

  const updateGeometry = useCallback(() => {
    const container = latest.current.host.container;
    const installed = manifest.current;
    if (!container || !draftAnchor.current || installed?.container !== container) {
      setDraftGeometry(null);
      return;
    }
    setDraftGeometry(measureDraftGeometry(container, draftAnchor.current, installed.value));
  }, []);

  useLayoutEffect(() => {
    const container = props.host.container;
    if (!container) return;
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(container);
    container.addEventListener("scroll", updateGeometry, { passive: true });
    updateGeometry();
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", updateGeometry);
    };
  }, [props.host.container, updateGeometry]);

  useEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      if (active.current === null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (input.current?.contains(target) || latest.current.host.container?.contains(target))
        return;
      finishEditing();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    return () => document.removeEventListener("pointerdown", pointerDown, true);
  }, [finishEditing]);

  useLayoutEffect(() => {
    const register = props.host.registerAnchorProvider;
    register?.(() => {
      const transaction = active.current ?? completedAnchor.current;
      const container = latest.current.host.container;
      if (!transaction || !container || (latest.current.host.rotation ?? 0) !== 0) return null;
      return captureVisualPresentationAnchor(
        container,
        transaction.presentedText,
        transaction.text,
      );
    });
    return () => register?.(null);
  }, [props.host.registerAnchorProvider]);

  useEffect(
    () => () => {
      clearCheckpointTimer();
      if (editingRef.current) {
        editingRef.current = false;
        latest.current.onEditingChange(false);
      }
      // Every input event writes this recovery copy before the debounce. Do not
      // mutate shared source during unmount; the surviving save owner may be changing modes.
    },
    [clearCheckpointTimer],
  );

  return (
    <>
      {recovery === null ? null : (
        <div className="scient-latex-visual-recovery" role="alert">
          <label>
            Recovered Visual draft — source was not changed
            <textarea aria-label="Recover unapplied visual source" readOnly value={recovery} />
          </label>
          <button
            type="button"
            onClick={() => {
              clearVisualDraft(props.draftKey);
              setRecovery(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <textarea
        ref={input}
        className={`scient-latex-visual-input${editing && draftGeometry ? " is-active" : ""}`}
        style={editing && draftGeometry ? draftGeometry : undefined}
        aria-label="Edit LaTeX prose on the typeset page"
        tabIndex={-1}
        spellCheck={false}
        onChange={() => {
          const textarea = input.current;
          const transaction = active.current;
          if (!textarea || !transaction) return;
          transaction.text = textarea.value;
          retainTransactionDraft(transaction, textarea.value);
          if (draftGeometry) {
            textarea.style.height = `${draftGeometry.height}px`;
            textarea.style.height = `${Math.max(draftGeometry.height, textarea.scrollHeight)}px`;
          }
          scheduleCheckpoint();
        }}
        onCompositionStart={() => {
          composing.current = true;
          clearCheckpointTimer();
        }}
        onCompositionEnd={() => {
          composing.current = false;
          if (active.current !== null) scheduleCheckpoint();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || composing.current) return;
          finishEditing();
          input.current?.blur();
          props.host.container?.focus({ preventScroll: true });
        }}
        // Focus follows clicks and IME windows. It is deliberately not the
        // editing-session boundary; only Escape or leaving the document is.
        onBlur={() => undefined}
      />
    </>
  );
}
