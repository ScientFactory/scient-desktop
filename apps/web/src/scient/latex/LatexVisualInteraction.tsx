import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PdfInteractionHost, PdfInverseSyncPoint } from "~/scient/pdf/ScientPdfReader";
import {
  editVisualRun,
  matchVisualRun,
  visualCharacters,
  type VisualRun,
} from "@t3tools/shared/latexVisual";
import { rebaseVisualMatch, sourceChange, type SourceChange } from "./visualEditingSession";
import {
  measureDraftGeometry,
  visualTextHit,
  type DraftAnchor,
  type DraftGeometry,
} from "./visualPageGeometry";
import { clearVisualDraft, readVisualDraft, retainVisualDraft } from "./visualDrafts";
import { captureVisualPresentationAnchor } from "./visualPresentationAnchor";

interface ActiveEdit {
  pending: boolean;
  readonly baseSource: string;
  readonly run: VisualRun;
  source: string;
  text: string;
  presentedText: string;
  page: number;
}

interface MappingSession {
  readonly revisionId: string;
  readonly baseSource: string;
  currentSource: string;
  readonly changes: SourceChange[];
}

export interface LatexVisualInteractionProps {
  readonly draftKey: string;
  readonly failureMessage?: string | null;
  readonly host: PdfInteractionHost;
  readonly source: string;
  readonly sourceRevision: string | null;
  readonly ready: boolean;
  readonly revisionId: string | null;
  readonly locate: (point: PdfInverseSyncPoint) => Promise<number | string>;
  /** Compare-and-set against the shared editor buffer, not just its last saved disk revision. */
  readonly onEdit: (expected: string, next: string) => boolean;
  readonly onEditingChange: (editing: boolean) => void;
}

export function LatexVisualInteraction(props: LatexVisualInteractionProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const active = useRef<ActiveEdit | null>(null);
  const mapping = useRef<MappingSession | null>(null);
  const draftAnchor = useRef<DraftAnchor | null>(null);
  const composing = useRef(false);
  const request = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const [sourceHash, setSourceHash] = useState<{ source: string; hash: string } | null>(null);
  const [message, setMessage] = useState(
    "Click text on the page to edit. Pages update after typesetting.",
  );
  const [caret, setCaret] = useState<{ left: number; top: number; height: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(() => readVisualDraft(props.draftKey));
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const [selectionRects, setSelectionRects] = useState<
    readonly { left: number; top: number; width: number; height: number }[]
  >([]);
  const [draftGeometry, setDraftGeometry] = useState<DraftGeometry | null>(null);

  useEffect(() => {
    if (!globalThis.crypto?.subtle) {
      setMessage("Source verification requires a secure connection. Use Source mode.");
      return;
    }
    let current = true;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(props.source))
      .then((bytes) => {
        if (current)
          setSourceHash({
            source: props.source,
            hash: `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
          });
      })
      .catch(() => {
        if (current) setMessage("Source verification is unavailable. Use Source mode.");
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
  const mappingReady =
    props.host.ready &&
    (props.host.rotation ?? 0) === 0 &&
    mapping.current !== null &&
    mapping.current.revisionId === props.host.revisionId &&
    mapping.current.currentSource === props.source;
  const mappingReadyRef = useRef(mappingReady);
  mappingReadyRef.current = mappingReady;
  const exactlyCurrentRef = useRef(exactlyCurrent);
  exactlyCurrentRef.current = exactlyCurrent;

  useEffect(() => {
    if (!editing) return;
    props.onEditingChange(true);
    return () => props.onEditingChange(false);
  }, [editing, props.onEditingChange]);

  function refuse(message: string) {
    const transaction = active.current;
    const draft = input.current?.value ?? transaction?.text;
    if (transaction?.pending && draft !== undefined && draft !== transaction.run.text) {
      retainVisualDraft(latest.current.draftKey, draft);
      setRecovery((previous) => (previous === null ? draft : `${previous}\n\n${draft}`));
    }
    active.current = null;
    setEditing(false);
    setLocating(false);
    setCaret(null);
    draftAnchor.current = null;
    setDraftGeometry(null);
    setMessage(message);
  }

  // An external update cannot silently rebase an active visual transaction.
  useEffect(() => {
    if (active.current && active.current.source !== props.source) {
      refuse("Source changed outside this edit. Wait for the build, then click to continue.");
      mapping.current = null;
    } else if (mapping.current && mapping.current.currentSource !== props.source) {
      mapping.current = null;
      setMessage("Source changed outside Visual. Wait for its PDF before editing the page.");
    }
  }, [props.source]);

  useEffect(() => {
    const container = props.host.container;
    if (!container) return;
    const click = (event: MouseEvent) => {
      const hit = visualTextHit(event, container);
      if (!hit) return;
      if (recoveryRef.current !== null) {
        setMessage("Copy or dismiss the unapplied draft before starting another edit.");
        return;
      }
      const session = mapping.current;
      if (!mappingReadyRef.current || !session) {
        setMessage(
          (latest.current.host.rotation ?? 0) !== 0
            ? "Rotate the page upright to edit text."
            : "Waiting for a verified current PDF. Rebuild if this document was just opened.",
        );
        return;
      }
      const pageElement = hit.span.closest<HTMLElement>(".page[data-page-number]");
      if (!pageElement) return;
      const current = latest.current;
      const point = current.host.pointFromClient({
        pageElement,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (!point) return;
      const issued = ++request.current;
      const selection = document.getSelection();
      const endpoints =
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode instanceof Text &&
        selection.focusNode instanceof Text &&
        container.contains(selection.anchorNode) &&
        container.contains(selection.focusNode)
          ? {
              anchorText: selection.anchorNode.data,
              anchorOffset: selection.anchorOffset,
              focusText: selection.focusNode.data,
              focusOffset: selection.focusOffset,
            }
          : null;
      if (active.current?.pending) {
        const hadInput = input.current?.value !== active.current.run.text;
        refuse("The previous source lookup was superseded.");
        if (hadInput) return;
      }
      // Local uniqueness can admit input immediately, but cannot authorize a
      // write. Buffer early keystrokes until revision-scoped SyncTeX agrees.
      const provisionalBase =
        endpoints === null
          ? matchVisualRun(session.baseSource, hit.node.data, hit.offset, null)
          : null;
      const provisional = provisionalBase
        ? rebaseVisualMatch(provisionalBase, current.source, session.changes)
        : null;
      if (provisional && input.current) {
        draftAnchor.current = { span: hit.span, page: pageElement, run: provisionalBase!.run };
        setDraftGeometry(measureDraftGeometry(container, draftAnchor.current));
        active.current = {
          pending: true,
          baseSource: current.source,
          source: current.source,
          run: provisional.run,
          text: provisional.run.text,
          presentedText: provisional.run.text,
          page: point.page,
        };
        input.current.value = provisional.run.text;
        input.current.focus({ preventScroll: true });
        input.current.setSelectionRange(provisional.offset, provisional.offset);
        setEditing(true);
        updateCaret();
      }
      setLocating(true);
      setMessage("Locating source…");
      void current
        .locate(point)
        .then((line) => {
          if (issued !== request.current) return;
          if (
            latest.current.source !== current.source ||
            latest.current.revisionId !== current.revisionId ||
            mapping.current !== session ||
            !mappingReadyRef.current
          ) {
            refuse("Source or PDF changed during lookup. Pending input was not applied.");
            return;
          }
          if (typeof line === "string") {
            refuse(line);
            return;
          }
          const baseMatch = matchVisualRun(session.baseSource, hit.node.data, hit.offset, line);
          const match = baseMatch
            ? rebaseVisualMatch(baseMatch, current.source, session.changes)
            : null;
          if (!match) {
            refuse("This region has no unambiguous editable prose mapping. Use Source for it.");
            return;
          }
          const textarea = input.current;
          if (!textarea) return;
          if (active.current?.pending) {
            if (
              active.current.run.from !== match.run.from ||
              active.current.run.to !== match.run.to
            ) {
              refuse("Source mapping changed. Pending input was not applied.");
              return;
            }
            active.current.pending = false;
            setLocating(false);
            commit();
            updateCaret();
            return;
          }
          let start = match.offset;
          let end = match.offset;
          if (endpoints) {
            const baseAnchor = matchVisualRun(
              session.baseSource,
              endpoints.anchorText,
              endpoints.anchorOffset,
              line,
            );
            const baseFocus = matchVisualRun(
              session.baseSource,
              endpoints.focusText,
              endpoints.focusOffset,
              line,
            );
            const anchor = baseAnchor
              ? rebaseVisualMatch(baseAnchor, current.source, session.changes)
              : null;
            const focus = baseFocus
              ? rebaseVisualMatch(baseFocus, current.source, session.changes)
              : null;
            if (
              !anchor ||
              !focus ||
              anchor.run.from !== match.run.from ||
              focus.run.from !== match.run.from
            ) {
              refuse(
                "This selection crosses a protected source boundary. Select text within one prose region.",
              );
              return;
            }
            start = Math.min(anchor.offset, focus.offset);
            end = Math.max(anchor.offset, focus.offset);
          }
          active.current = {
            pending: false,
            baseSource: current.source,
            source: current.source,
            run: match.run,
            text: match.run.text,
            presentedText: match.run.text,
            page: point.page,
          };
          draftAnchor.current = { span: hit.span, page: pageElement, run: baseMatch!.run };
          setDraftGeometry(measureDraftGeometry(container, draftAnchor.current));
          textarea.value = match.run.text;
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(start, end);
          setEditing(true);
          setLocating(false);
          setMessage("Editing text · Escape finishes · page updates after typesetting");
          updateCaret();
        })
        .catch((error: unknown) => {
          if (issued === request.current)
            refuse(error instanceof Error ? error.message : "Source navigation failed.");
        });
    };
    container.addEventListener("click", click);
    return () => {
      ++request.current;
      container.removeEventListener("click", click);
    };
  }, [props.host.container]);

  function updateCaret() {
    const transaction = active.current;
    const textarea = input.current;
    const container = latest.current.host.container;
    if (!transaction || !textarea || !container || (latest.current.host.rotation ?? 0) !== 0) {
      setCaret(null);
      setSelectionRects([]);
      return;
    }
    if (draftAnchor.current) {
      setDraftGeometry(measureDraftGeometry(container, draftAnchor.current));
      return;
    }
    // Never guess geometry for text which has not been typeset yet.
    if (!exactlyCurrentRef.current || transaction.source !== latest.current.source) return;
    transaction.presentedText = transaction.text;
    const source = visualCharacters(transaction.text);
    const selection = textarea.selectionStart;
    let selected = source.offsets.findIndex((offset) => offset >= selection);
    if (selected < 0) selected = source.text.length;
    let selectedEnd = source.offsets.findIndex((offset) => offset >= textarea.selectionEnd);
    if (selectedEnd < 0) selectedEnd = source.text.length;
    const rects: { left: number; top: number; width: number; height: number }[] = [];
    const hostRect = container.parentElement!.getBoundingClientRect();
    const hits: { node: Text; offset: number }[] = [];
    for (const span of container.querySelectorAll<HTMLElement>(
      ".page[data-page-number] .textLayer span",
    )) {
      const node = span.firstChild;
      if (!(node instanceof Text) || span.childNodes.length !== 1 || span.dir === "rtl") continue;
      const text = visualCharacters(node.data);
      if (text.text.length < 3) continue;
      const index = source.text.indexOf(text.text);
      if (index < 0 || source.text.indexOf(text.text, index + 1) >= 0) continue;
      if (selected >= index && selected <= index + text.text.length)
        hits.push({ node, offset: text.offsets[selected - index]! });
      if (selectedEnd > selected && selectedEnd > index && selected < index + text.text.length) {
        const range = document.createRange();
        range.setStart(node, text.offsets[Math.max(0, selected - index)]!);
        range.setEnd(node, text.offsets[Math.min(text.text.length, selectedEnd - index)]!);
        for (const rect of range.getClientRects())
          rects.push({
            left: rect.left - hostRect.left,
            top: rect.top - hostRect.top,
            width: rect.width,
            height: rect.height,
          });
      }
    }
    setSelectionRects(rects);
    if (hits.length !== 1) {
      setCaret(null);
      return;
    }
    const hit = hits[0]!;
    const range = document.createRange();
    const end = hit.offset === hit.node.length;
    range.setStart(hit.node, end ? Math.max(0, hit.offset - 1) : hit.offset);
    range.setEnd(hit.node, Math.min(hit.node.length, end ? hit.offset : hit.offset + 1));
    const rect = range.getBoundingClientRect();
    setCaret({
      left: (end ? rect.right : rect.left) - hostRect.left,
      top: rect.top - hostRect.top,
      height: rect.height,
    });
  }

  useLayoutEffect(() => {
    const container = props.host.container;
    if (!container) return;
    // Text layers are virtualized and may finish after the PDF's ready event.
    const observer = new MutationObserver(updateCaret);
    observer.observe(container, { childList: true, subtree: true });
    const resize = new ResizeObserver(updateCaret);
    resize.observe(container);
    container.addEventListener("scroll", updateCaret);
    updateCaret();
    return () => {
      observer.disconnect();
      resize.disconnect();
      container.removeEventListener("scroll", updateCaret);
    };
  }, [
    props.host.container,
    props.host.ready,
    props.host.scale,
    props.host.rotation,
    props.revisionId,
    exactlyCurrent,
  ]);

  useLayoutEffect(() => {
    const register = props.host.registerAnchorProvider;
    register?.(() => {
      const transaction = active.current;
      const container = latest.current.host.container;
      if (
        !transaction ||
        transaction.pending ||
        !container ||
        (latest.current.host.rotation ?? 0) !== 0
      )
        return null;
      return captureVisualPresentationAnchor(
        container,
        transaction.presentedText,
        transaction.text,
      );
    });
    return () => register?.(null);
  }, [props.host.registerAnchorProvider]);

  function commit() {
    const transaction = active.current;
    const textarea = input.current;
    if (!transaction || !textarea) return;
    retainVisualDraft(latest.current.draftKey, textarea.value);
    if (composing.current) return;
    if (transaction.pending) {
      transaction.text = textarea.value;
      return;
    }
    const next = editVisualRun(transaction.baseSource, transaction.run, textarea.value);
    if (next === transaction.source) {
      clearVisualDraft(latest.current.draftKey);
      return;
    }
    const session = mapping.current;
    if (session === null || session.currentSource !== transaction.source) {
      setRecovery(textarea.value);
      setMessage("The visual mapping changed. This edit was preserved for recovery.");
      active.current = null;
      setEditing(false);
      setCaret(null);
      return;
    }
    if (!latest.current.onEdit(transaction.source, next)) {
      setRecovery(textarea.value);
      setMessage("Source changed. This edit was not applied; use Source to resolve the conflict.");
      active.current = null;
      setEditing(false);
      setCaret(null);
      return;
    }
    clearVisualDraft(latest.current.draftKey);
    session.changes.push(sourceChange(transaction.source, next));
    session.currentSource = next;
    transaction.source = next;
    transaction.text = textarea.value;
    setMessage("Editing source… the PDF will update when you finish.");
    updateCaret();
  }

  return (
    <>
      <div className="scient-latex-visual-status" role="status" aria-live="polite">
        {props.failureMessage ??
          (editing && mappingReady && !locating
            ? exactlyCurrent
              ? "Editing text · Escape finishes · page matches the current PDF"
              : "Editing text · Escape finishes · PDF updates when you finish"
            : message)}
      </div>
      {recovery === null ? null : (
        <div className="scient-latex-visual-recovery" role="alert">
          <label>
            Unapplied text — source was not changed
            <textarea aria-label="Recover unapplied visual text" readOnly value={recovery} />
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
      {editing && caret ? (
        <div
          className="scient-latex-visual-caret"
          style={{ left: caret.left, top: caret.top, height: caret.height }}
          aria-hidden="true"
        />
      ) : null}
      {editing
        ? selectionRects.map((rect) => (
            <div
              key={`${rect.left}:${rect.top}:${rect.width}:${rect.height}`}
              className="scient-latex-visual-selection"
              style={rect}
              aria-hidden="true"
            />
          ))
        : null}
      <textarea
        ref={input}
        className={`scient-latex-visual-input${editing && draftGeometry ? " is-active" : ""}`}
        style={
          editing && draftGeometry
            ? draftGeometry
            : { left: caret?.left ?? 0, top: caret?.top ?? 0 }
        }
        aria-label="Edit LaTeX prose on the typeset page"
        tabIndex={-1}
        spellCheck={false}
        onChange={() => {
          const textarea = input.current;
          if (textarea && draftGeometry) {
            textarea.style.height = `${draftGeometry.height}px`;
            textarea.style.height = `${Math.max(draftGeometry.height, textarea.scrollHeight)}px`;
          }
          commit();
        }}
        onSelect={updateCaret}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !composing.current) {
            ++request.current;
            refuse("Click text on the page to edit. Pages update after typesetting.");
            input.current?.blur();
            props.host.container?.focus({ preventScroll: true });
            setMessage("Click text on the page to edit. Pages update after typesetting.");
          }
        }}
        onBlur={() => {
          setEditing(false);
          setCaret(null);
          draftAnchor.current = null;
          setDraftGeometry(null);
        }}
      />
    </>
  );
}
