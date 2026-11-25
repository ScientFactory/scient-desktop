import { T, useGT } from "gt-react";
import type { PdfSourceDescriptor, PdfTarget } from "@scientfactory/document-artifacts";
import {
  isScientRegionAnchor,
  scientAnnotationPages,
  scientAnnotationQuote,
  type ScientAnnotationAlternative,
  type ScientPdfAnnotation,
  type ScientPdfAnnotationAnchor,
  type ScientPdfTextAnchor,
} from "@t3tools/contracts";
import {
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";

import type { ScientPdfRuntime } from "../pdf/pdfRuntime";
import {
  annotatedPdfKey,
  applyAnnotationVersion,
  createAnnotation,
  removeAnnotation,
  updateAnnotation,
  type AnnotatedPdf,
} from "./annotationState";
import { useCanChangeLibrary } from "../sources/sourcesCommands";
import { quoteInDocument } from "./documentQuoteTargets";
import { paintPdfAnnotations, type PdfAnnotationPainter } from "./pdfAnnotationPaint";
import { startPdfRegionDrawing } from "./pdfRegionDrawing";
import type { QuoteCitation, QuoteCitationChoice } from "./quoteCitation";
import { quotePageLabels } from "./quoteFormat";
import { useDocumentAnnotations } from "./useDocumentAnnotations";

/** What the reader can do with annotations, when its PDF can hold them and they can change. */
export interface PdfAnnotationActions {
  readonly highlight: (target: PdfTarget) => void;
  readonly note: (target: PdfTarget, bounds: DOMRect) => void;
  /** Drawing a box on a page, which needs no text. */
  readonly area: {
    readonly drawing: boolean;
    readonly setDrawing: (drawing: boolean) => void;
  };
}

export const PdfAnnotationActionsContext = createContext<PdfAnnotationActions | null>(null);

type OpenNote =
  | {
      readonly _tag: "draft";
      readonly pdfKey: string;
      readonly anchor: ScientPdfAnnotationAnchor;
      readonly bounds: DOMRect;
    }
  | { readonly _tag: "saved"; readonly annotationId: string; readonly bounds: DOMRect };

function anchorOf(target: PdfTarget): ScientPdfTextAnchor {
  return { extractor: target.extractor, selector: target.selector };
}

/**
 * Highlights, notes and marked areas in a PDF reader: paints the saved ones on the pages,
 * opens one when it is clicked, and gives the selection bar Highlight and Note. The reader
 * provides `actions` through `PdfAnnotationActionsContext` and draws `overlay`.
 */
export function usePdfAnnotationLayer(props: {
  readonly source: PdfSourceDescriptor | null;
  readonly container: HTMLElement | null;
  readonly runtimeRef: RefObject<ScientPdfRuntime | null>;
  readonly ready: boolean;
}): { readonly actions: PdfAnnotationActions | null; readonly overlay: ReactNode } {
  const { container, ready, runtimeRef } = props;
  const { pdf, annotations, citation, alternatives } = useDocumentAnnotations(
    ready ? props.source : null,
  );
  const pdfKey = pdf && annotatedPdfKey(pdf);
  const canChange = useCanChangeLibrary(pdf?.environmentId ?? null);
  const fileName = props.source?.fileName ?? "document.pdf";
  const painterRef = useRef<PdfAnnotationPainter | null>(null);
  const annotationsRef = useRef(annotations);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps annotationsRef holding the latest annotations for a painter created later
  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  });
  const [requestedNote, setOpen] = useState<OpenNote | null>(null);
  const open =
    requestedNote?._tag === "draft" && requestedNote.pdfKey !== pdfKey ? null : requestedNote;
  const [drawingPdfKey, setDrawingPdfKey] = useState<string | null>(null);
  const canAnnotate = pdf !== null && canChange;
  const drawing = drawingPdfKey === pdfKey && canAnnotate && ready;
  // The source the writer chose to cite for this PDF, kept while the reader is open.
  const [chosen, setChosen] = useState<{
    readonly pdfKey: string;
    readonly sourceId: string;
  } | null>(null);
  const chosenCitation =
    pdf && citation.kind === "choose" && chosen?.pdfKey === annotatedPdfKey(pdf)
      ? (citation.choices.find((choice) => choice.sourceId === chosen.sourceId) ?? null)
      : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the painter that draws saved annotations into the pdf.js text layers of this reader
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!container || !ready || !runtime || !pdf) return;
    const painter = paintPdfAnnotations(runtime, container);
    painter.update(annotationsRef.current);
    painterRef.current = painter;
    const openAt = (event: MouseEvent) => {
      if (container.dataset.drawingRegion !== undefined) return;
      if (event.button !== 0 || !document.getSelection()?.isCollapsed) return;
      const hit = painter.annotationAt(event.clientX, event.clientY);
      if (!hit) return;
      const bounds = painter.boundsOf(hit.annotationId);
      if (bounds) setOpen({ _tag: "saved", annotationId: hit.annotationId, bounds });
    };
    container.addEventListener("click", openAt);
    return () => {
      container.removeEventListener("click", openAt);
      painter.dispose();
      painterRef.current = null;
    };
  }, [container, pdf, ready, runtimeRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- repaints the pdf.js text layers when the saved annotations change
  useEffect(() => {
    painterRef.current?.update(annotations);
  }, [annotations]);

  const draftArea =
    open?._tag === "draft" && isScientRegionAnchor(open.anchor) ? open.anchor : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows the box waiting for its note on the pdf.js page
  useEffect(() => {
    painterRef.current?.showDraft(draftArea);
  }, [draftArea]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the pointer listeners on the pdf.js pages while a box is drawn
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!drawing || !pdfKey || !container || !runtime) return;
    return startPdfRegionDrawing(runtime, container, {
      onDrawn: (anchor, bounds) => {
        setDrawingPdfKey(null);
        setOpen({ _tag: "draft", pdfKey, anchor, bounds });
      },
      onCancel: () => setDrawingPdfKey(null),
    });
  }, [container, drawing, pdfKey, runtimeRef]);

  const actions: PdfAnnotationActions | null =
    pdf && pdfKey && canChange
      ? {
          highlight: (target) => {
            void createAnnotation(pdf, { anchor: anchorOf(target), highlighted: true, note: "" });
          },
          note: (target, bounds) =>
            setOpen({ _tag: "draft", pdfKey, anchor: anchorOf(target), bounds }),
          area: {
            drawing,
            setDrawing: (next) => {
              setOpen(null);
              setDrawingPdfKey(next ? pdfKey : null);
            },
          },
        }
      : null;

  const saved =
    open?._tag === "saved"
      ? (annotations.find((annotation) => annotation.annotationId === open.annotationId) ?? null)
      : null;
  const showing = open !== null && (open._tag === "draft" || saved !== null);

  return {
    actions,
    overlay:
      pdf && showing ? (
        <AnnotationNotePopover
          key={open._tag === "draft" ? "draft" : open.annotationId}
          pdf={pdf}
          readOnly={!canChange}
          bounds={open.bounds}
          draft={open._tag === "draft" ? open.anchor : null}
          annotation={saved}
          alternatives={
            saved
              ? alternatives.filter(
                  (version) =>
                    version.annotationId === saved.annotationId &&
                    (version.note !== saved.note || version.highlighted !== saved.highlighted),
                )
              : []
          }
          citation={citation}
          chosenCitation={chosenCitation}
          onChooseCitation={(choice) =>
            setChosen({ pdfKey: annotatedPdfKey(pdf), sourceId: choice.sourceId })
          }
          onQuote={(annotation, citationKey) => {
            const pages = scientAnnotationPages(annotation);
            void documentPageLabels(runtimeRef.current).then((labels) =>
              quoteInDocument(pdf.environmentId, pdf.root, {
                quote: scientAnnotationQuote(annotation),
                pages,
                pageLabels: quotePageLabels(pages, labels),
                citationKey,
                fileName,
              }),
            );
          }}
          onClose={() => setOpen(null)}
        />
      ) : null,
  };
}

/** The PDF's printed page labels, or null when it defines none or they cannot be read. */
async function documentPageLabels(
  runtime: ScientPdfRuntime | null,
): Promise<ReadonlyArray<string> | null> {
  if (!runtime) return null;
  try {
    return await runtime.document.getPageLabels();
  } catch {
    return null;
  }
}

function AnnotationNotePopover(props: {
  readonly pdf: AnnotatedPdf;
  readonly readOnly: boolean;
  readonly bounds: DOMRect;
  readonly draft: ScientPdfAnnotationAnchor | null;
  readonly annotation: ScientPdfAnnotation | null;
  /** Another computer's versions of this annotation, from a project package. */
  readonly alternatives: ReadonlyArray<ScientAnnotationAlternative>;
  /** Whom a quote cites; several sources sharing the PDF are chosen between before quoting. */
  readonly citation: QuoteCitation;
  /** The source already chosen for this PDF, when `citation` asks for a choice. */
  readonly chosenCitation: QuoteCitationChoice | null;
  readonly onChooseCitation: (choice: QuoteCitationChoice) => void;
  readonly onQuote: (annotation: ScientPdfAnnotation, citationKey: string | null) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { annotation, citation, chosenCitation, draft, pdf, onClose } = props;
  const [note, setNote] = useState(annotation?.note ?? "");
  const [choosing, setChoosing] = useState(false);
  const finish = (save: boolean) => {
    onClose();
    if (!save || props.readOnly) return;
    const text = note.trim().length === 0 ? "" : note;
    if (draft) {
      // A box is kept without a note; a text note without words is nothing.
      if (isScientRegionAnchor(draft)) {
        void createAnnotation(pdf, { anchor: draft, highlighted: text === "", note: text });
      } else if (text) {
        void createAnnotation(pdf, { anchor: draft, highlighted: false, note: text });
      }
      return;
    }
    if (!annotation || text === annotation.note) return;
    if (!text && !annotation.highlighted) void removeAnnotation(pdf, annotation);
    else void updateAnnotation(pdf, annotation, { note: text });
  };
  const quote = (citationKey: string | null) => {
    if (!annotation) return;
    finish(true);
    props.onQuote(annotation, citationKey);
  };
  const quoteNow = () => {
    if (citation.kind === "cite") quote(citation.citationKey);
    else if (citation.kind === "none") quote(null);
    else if (chosenCitation) quote(chosenCitation.citationKey);
    else setChoosing(true);
  };
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(next, details) => {
        if (!next) finish(details.reason !== "escape-key");
      }}
    >
      <PopoverPopup
        anchor={{ getBoundingClientRect: () => props.bounds }}
        side="bottom"
        align="start"
        width="md"
        padding="tight"
        initialFocus
      >
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={gt("Note", { $context: "noun, a note on a source" })}
            placeholder={gt("Add a note")}
            rows={2}
            size="sm"
            readOnly={props.readOnly}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                finish(true);
              }
            }}
          />
          {annotation
            ? props.alternatives.map((version) => (
                <div
                  key={`${version.revision}:${version.note}:${version.highlighted}`}
                  className="flex flex-col gap-1 border-t border-border pt-2 text-xs"
                >
                  <span className="text-muted-foreground">
                    <T>Another computer's version</T>
                  </span>
                  <p className="whitespace-pre-wrap break-words">
                    {version.note || (version.highlighted ? gt("Highlight only") : "")}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    disabled={props.readOnly}
                    onClick={() => {
                      onClose();
                      void applyAnnotationVersion(pdf, annotation, version);
                    }}
                  >
                    <T>Use this version</T>
                  </Button>
                </div>
              ))
            : null}
          {annotation && citation.kind === "choose" && choosing ? (
            <div
              role="group"
              aria-label={gt("Source to cite")}
              className="flex flex-col gap-1 border-t border-border pt-2 text-xs"
            >
              <span className="text-muted-foreground">
                <T>Several Library sources have this PDF. Which one should the quote cite?</T>
              </span>
              {citation.choices.map((choice) => (
                <Button
                  key={choice.sourceId}
                  type="button"
                  variant="ghost"
                  size="sm-multiline"
                  className="justify-start text-left"
                  onClick={() => {
                    props.onChooseCitation(choice);
                    quote(choice.citationKey);
                  }}
                >
                  <span className="flex min-w-0 flex-col items-start text-xs font-normal">
                    <span className="break-words">{choice.title ?? `@${choice.citationKey}`}</span>
                    {choice.title ? (
                      <span className="text-muted-foreground">@{choice.citationKey}</span>
                    ) : null}
                  </span>
                </Button>
              ))}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  onClick={() => setChoosing(false)}
                >
                  <T>Cancel</T>
                </Button>
              </div>
            </div>
          ) : (
            <>
              {annotation && chosenCitation ? (
                <div className="flex items-center justify-between gap-1 text-xs">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {gt("Quotes cite {work}", {
                      work: chosenCitation.title ?? `@${chosenCitation.citationKey}`,
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={() => setChoosing(true)}
                  >
                    <T context="verb, button">Change</T>
                  </Button>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-1">
                {annotation ? (
                  <Button
                    type="button"
                    variant="ghost-destructive"
                    size="compact"
                    disabled={props.readOnly}
                    onClick={() => {
                      onClose();
                      void removeAnnotation(pdf, annotation);
                    }}
                  >
                    <T context="verb, button">Remove</T>
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-1">
                  {annotation && !isScientRegionAnchor(annotation.anchor) ? (
                    <Button type="button" variant="ghost" size="compact" onClick={quoteNow}>
                      <T>Quote in my document</T>
                    </Button>
                  ) : null}
                  <Button type="button" variant="ghost" size="compact" onClick={() => finish(true)}>
                    <T>Done</T>
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
