import type { PdfSourceDescriptor, PdfTarget } from "@scientfactory/document-artifacts";
import {
  scientAnnotationQuote,
  type ScientAnnotationAlternative,
  type ScientPdfAnnotation,
  type ScientPdfAnnotationAnchor,
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
  applyAnnotationVersion,
  createAnnotation,
  removeAnnotation,
  updateAnnotation,
  type AnnotatedPdf,
} from "./annotationState";
import { useCanChangeLibrary } from "../sources/sourcesCommands";
import { quoteInDocument } from "./documentQuoteTargets";
import { paintPdfAnnotations, type PdfAnnotationPainter } from "./pdfAnnotationPaint";
import { useDocumentAnnotations } from "./useDocumentAnnotations";

/** What a text selection in the reader can do with annotations, when its PDF can hold them. */
export interface PdfAnnotationActions {
  readonly highlight: (target: PdfTarget) => void;
  readonly note: (target: PdfTarget, bounds: DOMRect) => void;
}

export const PdfAnnotationActionsContext = createContext<PdfAnnotationActions | null>(null);

type OpenNote =
  | { readonly _tag: "draft"; readonly anchor: ScientPdfAnnotationAnchor; readonly bounds: DOMRect }
  | { readonly _tag: "saved"; readonly annotationId: string; readonly bounds: DOMRect };

function anchorOf(target: PdfTarget): ScientPdfAnnotationAnchor {
  return { extractor: target.extractor, selector: target.selector };
}

/**
 * Highlights and notes in a PDF reader: paints the saved ones on the pages,
 * opens one when it is clicked, and gives the selection bar Highlight and Note.
 */
export function PdfAnnotationLayer(props: {
  readonly source: PdfSourceDescriptor | null;
  readonly container: HTMLElement | null;
  readonly runtimeRef: RefObject<ScientPdfRuntime | null>;
  readonly ready: boolean;
  readonly children: ReactNode;
}) {
  const { container, ready, runtimeRef } = props;
  const { pdf, annotations, citationKey, alternatives } = useDocumentAnnotations(props.source);
  const canChange = useCanChangeLibrary(pdf?.environmentId ?? null);
  const fileName = props.source?.fileName ?? "document.pdf";
  const painterRef = useRef<PdfAnnotationPainter | null>(null);
  const annotationsRef = useRef(annotations);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps annotationsRef holding the latest annotations for a painter created later
  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  });
  const [open, setOpen] = useState<OpenNote | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the painter that draws saved annotations into the pdf.js text layers of this reader
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!container || !ready || !runtime || !pdf) return;
    const painter = paintPdfAnnotations(runtime, container);
    painter.update(annotationsRef.current);
    painterRef.current = painter;
    const openAt = (event: MouseEvent) => {
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

  const actions: PdfAnnotationActions | null =
    pdf && canChange
      ? {
          highlight: (target) => {
            void createAnnotation(pdf, { anchor: anchorOf(target), highlighted: true, note: "" });
          },
          note: (target, bounds) => setOpen({ _tag: "draft", anchor: anchorOf(target), bounds }),
        }
      : null;

  const saved =
    open?._tag === "saved"
      ? (annotations.find((annotation) => annotation.annotationId === open.annotationId) ?? null)
      : null;
  const showing = open !== null && (open._tag === "draft" || saved !== null);

  return (
    <PdfAnnotationActionsContext value={actions}>
      {props.children}
      {pdf && showing ? (
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
          onQuote={(annotation) =>
            void quoteInDocument(pdf.root, {
              quote: scientAnnotationQuote(annotation),
              pages: annotation.anchor.selector.pages.map((page) => page.page),
              citationKey,
              fileName,
            })
          }
          onClose={() => setOpen(null)}
        />
      ) : null}
    </PdfAnnotationActionsContext>
  );
}

function AnnotationNotePopover(props: {
  readonly pdf: AnnotatedPdf;
  readonly readOnly: boolean;
  readonly bounds: DOMRect;
  readonly draft: ScientPdfAnnotationAnchor | null;
  readonly annotation: ScientPdfAnnotation | null;
  /** Another computer's versions of this annotation, from a project package. */
  readonly alternatives: ReadonlyArray<ScientAnnotationAlternative>;
  readonly onQuote: (annotation: ScientPdfAnnotation) => void;
  readonly onClose: () => void;
}) {
  const { annotation, draft, pdf, onClose } = props;
  const [note, setNote] = useState(annotation?.note ?? "");
  const finish = (save: boolean) => {
    onClose();
    if (!save || props.readOnly) return;
    const text = note.trim().length === 0 ? "" : note;
    if (draft) {
      if (text) void createAnnotation(pdf, { anchor: draft, highlighted: false, note: text });
      return;
    }
    if (!annotation || text === annotation.note) return;
    if (!text && !annotation.highlighted) void removeAnnotation(pdf, annotation);
    else void updateAnnotation(pdf, annotation, { note: text });
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
            aria-label="Note"
            placeholder="Add a note"
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
                  <span className="text-muted-foreground">Another computer's version</span>
                  <p className="whitespace-pre-wrap break-words">
                    {version.note || (version.highlighted ? "Highlight only" : "")}
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
                    Use this version
                  </Button>
                </div>
              ))
            : null}
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
                Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-1">
              {annotation ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  onClick={() => {
                    finish(true);
                    props.onQuote(annotation);
                  }}
                >
                  Quote in my document
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="compact" onClick={() => finish(true)}>
                Done
              </Button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
