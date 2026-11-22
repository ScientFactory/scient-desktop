import { msg, T, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import { PdfTarget } from "@scientfactory/document-artifacts";
import {
  scientAnnotationQuote,
  type EnvironmentId,
  type ScientSourceDetailResult,
  type ScientPdfAnnotation,
  type ScientUnplacedAnnotation,
} from "@t3tools/contracts";
import { TextQuote, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";

import { ScientTooltip } from "../presentation/ScientTooltip";

import { pdfRevealDocumentKey, requestPdfReveal } from "../pdf/anchors/pdfRevealRequests";
import { pdfDocumentIdentity } from "../pdf/anchors/pdfTextTarget";
import { pdfSourceAssetResource, workspacePdfSource } from "../pdf/pdfSource";
import {
  annotatedPdfKey,
  removeAnnotation,
  removeUnplacedAnnotation,
  storePdfAnnotations,
  type AnnotatedPdf,
} from "./annotationState";
import { useCanChangeLibrary } from "../sources/sourcesCommands";
import { readSourceAnnotations } from "./client";
import { quoteInDocument } from "./documentQuoteTargets";
import { readQuotePageLabels } from "./pdfQuotePageLabels";
import { quotePageLabels } from "./quoteFormat";
import { usePdfAnnotations } from "./useDocumentAnnotations";

type SourceAttachment = ScientSourceDetailResult["attachments"][number];

const NO_UNPLACED: ReadonlyArray<ScientUnplacedAnnotation> = [];

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
  const [loaded, setLoaded] = useState<{
    readonly sourceId: string;
    readonly ready: boolean;
    /** Highlights another reader held that are not on the page, by PDF. */
    readonly unplaced: ReadonlyMap<string, ReadonlyArray<ScientUnplacedAnnotation>>;
  }>({ sourceId, ready: false, unplaced: new Map() });

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
          setLoaded({
            sourceId,
            ready: true,
            unplaced: new Map(
              result.attachments.map((attachment) => [
                attachment.attachmentId,
                attachment.unplaced ?? NO_UNPLACED,
              ]),
            ),
          });
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
  const showChange = (attachmentId: string, next: ScientUnplacedAnnotation) =>
    setLoaded((current) => ({
      ...current,
      unplaced: new Map(current.unplaced).set(
        attachmentId,
        (current.unplaced.get(attachmentId) ?? NO_UNPLACED).map((entry) =>
          entry.annotationId === next.annotationId ? next : entry,
        ),
      ),
    }));
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
          unplaced={(loaded.unplaced.get(attachment.attachmentId) ?? NO_UNPLACED).filter(
            (entry) => entry.deletedAt === null,
          )}
          titled={pdfs.length > 1}
          citationKey={props.record.citationKey ?? null}
          onOpenPdf={props.onOpenPdf}
          onChanged={(next) => showChange(attachment.attachmentId, next)}
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
  readonly unplaced: ReadonlyArray<ScientUnplacedAnnotation>;
  readonly titled: boolean;
  readonly citationKey: string | null;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
  readonly onChanged: (next: ScientUnplacedAnnotation) => void;
}) {
  const m = useMessages();
  const gt = useGT();
  const { attachment, environmentId, root, sourceId } = props;
  const pdf: AnnotatedPdf = {
    environmentId,
    root,
    material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
  };
  const annotations = usePdfAnnotations(pdf);
  const canChange = useCanChangeLibrary(environmentId);
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
  const pdfUrl = useAssetUrlRefresh(environmentId, pdfSourceAssetResource(descriptor));
  if (annotations.length === 0 && props.unplaced.length === 0) return null;

  const openPdf = () =>
    props.onOpenPdf({
      sourceId,
      attachmentId: attachment.attachmentId,
      fileName: attachment.fileName,
    });
  const open = (annotation: ScientPdfAnnotation) => {
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
    openPdf();
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.titled
          ? gt("Highlights and notes · {fileName}", { fileName: attachment.fileName })
          : gt("Highlights and notes")}
      </h3>
      <ul className="space-y-1">
        {annotations.map((annotation) => (
          <li key={annotation.annotationId} className="group/row flex items-start gap-1">
            <button
              type="button"
              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => open(annotation)}
            >
              <span
                className="line-clamp-3 border-l-2 border-warning/60 pl-2 text-sm"
                style={annotation.color ? { borderColor: annotation.color } : undefined}
              >
                {scientAnnotationQuote(annotation)}
              </span>
              {annotation.note ? (
                <span className="mt-1 block whitespace-pre-wrap text-sm text-muted-foreground">
                  {annotation.note}
                </span>
              ) : null}
              <span className="mt-1 block text-xs text-muted-foreground">
                {annotationMeta(annotation, m)}
              </span>
            </button>
            <ScientTooltip content="Quote in my document">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted-row"
                aria-label={gt("Quote in my document")}
                onClick={() => {
                  const pages = annotation.anchor.selector.pages.map((page) => page.page);
                  // The PDF is not open here: it is read briefly for its printed page labels.
                  void readQuotePageLabels({ contentKey: attachment.sha256, url: pdfUrl }).then(
                    (labels) =>
                      quoteInDocument(environmentId, root, {
                        quote: scientAnnotationQuote(annotation),
                        pages,
                        pageLabels: quotePageLabels(pages, labels),
                        citationKey: props.citationKey,
                        fileName: attachment.fileName,
                      }),
                  );
                }}
              >
                <TextQuote />
              </Button>
            </ScientTooltip>
            <ScientTooltip content="Remove">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted-row"
                aria-label={gt("Remove", { $context: "verb, button" })}
                disabled={!canChange}
                onClick={() => void removeAnnotation(pdf, annotation)}
              >
                <Trash2 />
              </Button>
            </ScientTooltip>
          </li>
        ))}
      </ul>
      {props.unplaced.length > 0 ? (
        <>
          <h4 className="text-xs text-muted-foreground">
            <T>From Zotero, not placed on the page</T>
          </h4>
          <ul className="space-y-1">
            {props.unplaced.map((entry) => (
              <li key={entry.annotationId} className="group/row flex items-start gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={openPdf}
                >
                  {entry.quote ? (
                    <span
                      className="line-clamp-3 border-l-2 border-warning/60 pl-2 text-sm"
                      style={entry.color ? { borderColor: entry.color } : undefined}
                    >
                      {entry.quote}
                    </span>
                  ) : null}
                  {entry.comment ? (
                    <span className="mt-1 block whitespace-pre-wrap text-sm text-muted-foreground">
                      {entry.comment}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {unplacedMeta(entry, m)}
                  </span>
                </button>
                <ScientTooltip content="Remove">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted-row"
                    aria-label={gt("Remove", { $context: "verb, button" })}
                    disabled={!canChange}
                    onClick={() => void removeUnplacedAnnotation(pdf, entry, props.onChanged)}
                  >
                    <Trash2 />
                  </Button>
                </ScientTooltip>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function annotationMeta(annotation: ScientPdfAnnotation, resolve: MessageResolver): string {
  const pages = annotation.anchor.selector.pages.map((page) => page.page);
  const where =
    pages.length === 1
      ? resolve(msg("Page {page}", { page: pages[0]! }))
      : resolve(msg("Pages {first}–{last}", { first: pages[0]!, last: pages.at(-1)! }));
  return annotation.createdBy === "agent"
    ? resolve(msg("{where} · Added by an agent", { where }))
    : where;
}

const UNPLACED_KINDS: Readonly<Record<ScientUnplacedAnnotation["kind"], string | null>> = {
  highlight: null,
  underline: msg("Underline", { $context: "a kind of PDF annotation" }),
  note: msg("Note on the page"),
  text: msg("Text on the page"),
  image: msg("Marked area"),
  ink: msg("Drawing", { $context: "a kind of PDF annotation" }),
};

function unplacedMeta(entry: ScientUnplacedAnnotation, resolve: MessageResolver): string {
  const words = UNPLACED_KINDS[entry.kind];
  const kind = words === null ? null : resolve(words);
  const where = entry.page === null ? null : resolve(msg("Page {page}", { page: entry.page }));
  return [where, kind].filter(Boolean).join(" · ");
}
