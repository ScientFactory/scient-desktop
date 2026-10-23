import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import type { PdfCitation, ScopedThreadRef } from "@t3tools/contracts";
import { pdfCitationFits } from "@t3tools/shared/pdfCitations";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useComposerHandleContext } from "~/composerHandleContext";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";

import type { ScientPdfRuntime } from "../pdfRuntime";
import {
  locatePdfQuote,
  paintPdfQuote,
  showPdfPage,
  type PdfRevealOutcome,
} from "./pdfQuoteReveal";
import { takePdfReveal, useOwnedPdfReveal } from "./pdfRevealRequests";
import { PDF_SELECTION_REFUSAL_COPY, readPdfTextSelection } from "./pdfTextLayer";
import { pdfDocumentIdentity, pdfTextTarget } from "./pdfTextTarget";

type Captured =
  | { readonly citation: PdfCitation; readonly range: Range }
  | { readonly refusal: string; readonly range: Range };

/**
 * Quotes inside a PDF reader: "Ask in chat" for a text selection, and the
 * highlight a quote chip asks for. Mounted once per reader, beside the pages.
 */
export function PdfQuoteLayer(props: {
  /** The reader's stable presentation mount; pages live inside it. */
  readonly container: HTMLElement | null;
  readonly runtimeRef: RefObject<ScientPdfRuntime | null>;
  /** The document actually painted, not the one being requested. */
  readonly presentedSource: PdfSourceDescriptor | null;
  /** The document a pending quote must name to be shown here. */
  readonly revealKey: string;
  /** The reader's claim on pending reveals (`usePdfRevealClaim`, held by its outer shell). */
  readonly revealOwner: object;
  /** The painted presentation is the requested one and is ready. */
  readonly ready: boolean;
  /** The conversation a quote belongs to; without it there is no Ask in chat. */
  readonly citeThread?: ScopedThreadRef | undefined;
}) {
  return (
    <>
      <PdfQuoteReveal {...props} />
      {props.citeThread && props.presentedSource ? (
        <PdfAskInChat {...props} citeThread={props.citeThread} source={props.presentedSource} />
      ) : null}
    </>
  );
}

function outcomeNotice(outcome: PdfRevealOutcome): { title: string; description: string } | null {
  switch (outcome._tag) {
    case "Exact":
      return null;
    case "Relocated":
      return {
        title: "Quote found by its text",
        description: "The page text differs from when it was quoted, so Scient searched for it.",
      };
    case "Ambiguous":
      return {
        title: "The quoted text appears more than once",
        description: `Showing page ${outcome.page}, where it was quoted.`,
      };
    case "NotFound":
      return {
        title: "Couldn't find the quoted text",
        description: `This PDF may have changed. Showing page ${outcome.page}, where it was quoted.`,
      };
    case "Incomplete":
      return {
        title: "Couldn't search the whole PDF in time",
        description: `Showing page ${outcome.page}, where it was quoted.`,
      };
  }
}

function PdfQuoteReveal(props: {
  readonly container: HTMLElement | null;
  readonly runtimeRef: RefObject<ScientPdfRuntime | null>;
  readonly revealKey: string;
  readonly revealOwner: object;
  readonly ready: boolean;
}) {
  const { container, ready, revealKey, runtimeRef } = props;
  const { revealOwner: owner } = props;
  // Only a request this reader's shell has claimed is shown here.
  const request = useOwnedPdfReveal(revealKey, owner);
  const clearHighlight = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!request || !ready || !container) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const controller = new AbortController();
    void locatePdfQuote(runtime, request.target, controller.signal).then(
      ({ outcome, highlight }) => {
        if (controller.signal.aborted || !takePdfReveal(revealKey, request.id)) return;
        clearHighlight.current?.();
        clearHighlight.current = highlight ? paintPdfQuote(runtime, highlight, container) : null;
        if (!highlight && outcome._tag !== "Exact" && outcome._tag !== "Relocated") {
          showPdfPage(runtime, outcome.page);
        }
        const notice = outcomeNotice(outcome);
        if (notice) toastManager.add({ type: "info", ...notice });
      },
      () => {
        if (controller.signal.aborted || !takePdfReveal(revealKey, request.id)) return;
        toastManager.add({ type: "error", title: "Couldn't show the quote in this PDF" });
      },
    );
    return () => controller.abort();
  }, [container, ready, request, revealKey, runtimeRef]);

  // The highlight belongs to one document and lasts until the reader is used.
  const highlightedKey = useRef(revealKey);
  useEffect(() => {
    if (highlightedKey.current === revealKey) return;
    highlightedKey.current = revealKey;
    clearHighlight.current?.();
    clearHighlight.current = null;
  }, [revealKey]);
  useEffect(() => {
    if (!container) return;
    const clear = () => {
      clearHighlight.current?.();
      clearHighlight.current = null;
    };
    container.addEventListener("pointerdown", clear);
    return () => {
      container.removeEventListener("pointerdown", clear);
      clear();
    };
  }, [container]);
  return null;
}

function PdfAskInChat(props: {
  readonly container: HTMLElement | null;
  readonly runtimeRef: RefObject<ScientPdfRuntime | null>;
  readonly source: PdfSourceDescriptor;
  readonly ready: boolean;
  readonly citeThread: ScopedThreadRef;
}) {
  const composerRef = useComposerHandleContext();
  const [shown, setShown] = useState<(Captured & { position: SelectionActionPoint }) | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const { container, ready, runtimeRef, source, citeThread } = props;
  const identity = pdfDocumentIdentity(source);
  const citable = composerRef !== null && identity !== null;

  const capture = (): Captured | null => {
    const runtime = runtimeRef.current;
    const selection = document.getSelection();
    if (!runtime || !ready || !identity) return null;
    const read = readPdfTextSelection(runtime, selection);
    if (read._tag === "Empty") return null;
    const range = selection!.getRangeAt(0);
    if (read._tag === "Refused") return { refusal: PDF_SELECTION_REFUSAL_COPY[read.reason], range };
    const built = pdfTextTarget({ document: identity, material: null, pages: read.pages });
    if (built._tag === "Refused") {
      return { refusal: PDF_SELECTION_REFUSAL_COPY[built.reason], range };
    }
    const citation: PdfCitation = {
      kind: "pdf",
      version: 1,
      environmentId: citeThread.environmentId,
      threadId: citeThread.threadId,
      target: built.target,
    };
    return pdfCitationFits(citation)
      ? { citation, range }
      : { refusal: PDF_SELECTION_REFUSAL_COPY["selection-too-large"], range };
  };
  const captureRef = useRef(capture);
  useLayoutEffect(() => {
    captureRef.current = capture;
  });

  useEffect(() => {
    if (!container || !citable) return;
    const clear = () => setShown(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = captureRef.current();
      if (!captured) {
        clear();
        return;
      }
      const rects = [...captured.range.getClientRects()].filter((rect) => rect.width > 0);
      const last = rects.at(-1) ?? captured.range.getBoundingClientRect();
      const bounds = container.getBoundingClientRect();
      if (last.bottom < bounds.top || last.top > bounds.bottom) {
        clear();
        return;
      }
      const pointerOnText =
        pointer !== null &&
        rects.some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setShown({
        ...captured,
        position: resolveSelectionActionPosition({
          bounds,
          selectionRect: last,
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: container,
      getActionElement: () => buttonRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    // Tab from the selection reaches the action, as in every other surface.
    const focusAction = (event: KeyboardEvent) => {
      const button = buttonRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !button ||
        button.contains(event.target as Node)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusAction, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusAction, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
      setShown(null);
    };
  }, [citable, container]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button || !shown) return;
    const rect = button.getBoundingClientRect();
    button.style.left = `${Math.max(8, Math.min(shown.position.x, window.innerWidth - rect.width - 8))}px`;
    button.style.top = `${Math.max(8, Math.min(shown.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [shown]);

  if (!shown || !citable) return null;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setShown(null);
  };
  const refusal = "refusal" in shown ? shown.refusal : null;
  const ask = () => {
    if (!("citation" in shown) || !container) return;
    const inserted =
      composerRef?.current?.citeText(shown.citation, {
        source: container,
        range: shown.range,
        viewport: container,
        // Other pages rendering are not this quote changing: the range stands
        // while its own text is still on the page.
        resolveRange: () =>
          shown.range.startContainer.isConnected &&
          shown.range.endContainer.isConnected &&
          !shown.range.collapsed
            ? shown.range
            : null,
      }) ?? false;
    if (!inserted) return;
    window.getSelection()?.removeAllRanges();
    dismiss();
  };
  return createPortal(
    <Button
      ref={buttonRef}
      type="button"
      size="xs"
      variant="glass"
      // Stays focusable when refused, so the reason is read out, not skipped.
      aria-disabled={refusal !== null || undefined}
      aria-label={refusal ?? "Ask in chat"}
      data-pdf-ask-in-chat=""
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      style={{ left: shown.position.x, top: shown.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={ask}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <span aria-live="polite">{refusal ?? "Ask in chat"}</span>
    </Button>,
    document.body,
  );
}
