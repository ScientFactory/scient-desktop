import { PdfTarget } from "@scientfactory/document-artifacts";
import {
  scientAnnotationQuote,
  type EnvironmentId,
  type ScientSourceDetailResult,
  type ScientPdfAnnotation,
} from "@t3tools/contracts";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";

import { pdfRevealDocumentKey, requestPdfReveal } from "../pdf/anchors/pdfRevealRequests";
import { pdfDocumentIdentity } from "../pdf/anchors/pdfTextTarget";
import { workspacePdfSource } from "../pdf/pdfSource";
import {
  annotatedPdfKey,
  removeAnnotation,
  storePdfAnnotations,
  type AnnotatedPdf,
} from "./annotationState";
import { readSourceAnnotations } from "./client";
import { usePdfAnnotations } from "./useDocumentAnnotations";

type SourceAttachment = ScientSourceDetailResult["attachments"][number];

/**
 * The highlights and notes on a Source's PDFs, in reading order. Absent when
 * there are none. A passage opens its PDF there.
 */
export function SourceAnnotations(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly record: ScientSourceDetailResult;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
}) {
  const { environmentId, root } = props;
  const sourceId = props.record.sourceId;
  const [loaded, setLoaded] = useState<{ readonly sourceId: string; readonly ready: boolean }>({
    sourceId,
    ready: false,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this Source's annotations from the server and again when the window returns to the front
  useEffect(() => {
    let current = true;
    const load = () => {
      void readSourceAnnotations(environmentId, { root, sourceId }).then(
        (result) => {
          if (!current) return;
          for (const attachment of result.attachments) {
            storePdfAnnotations(
              annotatedPdfKey({ environmentId, root, material: attachment.material }),
              attachment.annotations,
            );
          }
          setLoaded({ sourceId, ready: true });
        },
        () => undefined,
      );
    };
    load();
    const reload = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      current = false;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [environmentId, root, sourceId]);

  if (loaded.sourceId !== sourceId || !loaded.ready) return null;
  const pdfs = props.record.attachments.filter((attachment) => attachment.kind === "pdf");
  return (
    <>
      {pdfs.map((attachment) => (
        <AttachmentAnnotations
          key={attachment.attachmentId}
          environmentId={environmentId}
          root={root}
          sourceId={sourceId}
          attachment={attachment}
          titled={pdfs.length > 1}
          onOpenPdf={props.onOpenPdf}
        />
      ))}
    </>
  );
}

function AttachmentAnnotations(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
  readonly attachment: SourceAttachment;
  readonly titled: boolean;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
}) {
  const { attachment, environmentId, root, sourceId } = props;
  const pdf: AnnotatedPdf = {
    environmentId,
    root,
    material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
  };
  const annotations = usePdfAnnotations(pdf);
  if (annotations.length === 0) return null;

  const open = (annotation: ScientPdfAnnotation) => {
    const descriptor = workspacePdfSource({
      environmentId,
      fileName: attachment.fileName,
      workspaceRoot: root,
      relativePath: `.scient/sources/${attachment.relativePath}`,
      origin: {
        _tag: "source",
        workspaceRoot: root,
        sourceId,
        attachmentId: attachment.attachmentId,
      },
    });
    const document = pdfDocumentIdentity(descriptor);
    if (document) {
      requestPdfReveal(
        pdfRevealDocumentKey(descriptor),
        PdfTarget.make({
          version: 1,
          document,
          material: pdf.material,
          extractor: annotation.anchor.extractor,
          selector: annotation.anchor.selector,
        }),
      );
    }
    props.onOpenPdf({
      sourceId,
      attachmentId: attachment.attachmentId,
      fileName: attachment.fileName,
    });
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.titled ? `Highlights and notes · ${attachment.fileName}` : "Highlights and notes"}
      </h3>
      <ul className="space-y-1">
        {annotations.map((annotation) => (
          <li key={annotation.annotationId} className="group/row flex items-start gap-1">
            <button
              type="button"
              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => open(annotation)}
            >
              <span className="line-clamp-3 border-l-2 border-warning/60 pl-2 text-sm">
                {scientAnnotationQuote(annotation)}
              </span>
              {annotation.note ? (
                <span className="mt-1 block whitespace-pre-wrap text-sm text-muted-foreground">
                  {annotation.note}
                </span>
              ) : null}
              <span className="mt-1 block text-xs text-muted-foreground">
                {annotationMeta(annotation)}
              </span>
            </button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted-row"
              aria-label="Remove"
              onClick={() => void removeAnnotation(pdf, annotation)}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function annotationMeta(annotation: ScientPdfAnnotation): string {
  const pages = annotation.anchor.selector.pages.map((page) => page.page);
  const where = pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages[0]}–${pages.at(-1)}`;
  return annotation.createdBy === "agent" ? `${where} · Added by an agent` : where;
}
