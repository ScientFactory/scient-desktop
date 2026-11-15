import { PdfTarget } from "@scientfactory/document-artifacts";
import type { CitationItem } from "@scientfactory/scient-sources";
import type {
  ContextMenuItem,
  EnvironmentId,
  ScientSourceDetailResult,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";

import { readSourceAnnotations } from "../annotations/client";
import {
  pdfRevealDocumentKey,
  requestPdfPageReveal,
  requestPdfReveal,
} from "../pdf/anchors/pdfRevealRequests";
import { pdfDocumentIdentity } from "../pdf/anchors/pdfTextTarget";
import { workspacePdfSource } from "../pdf/pdfSource";
import { scientSourcePdfSurface } from "../rightPanel/surfaces";
import {
  citationChoiceText,
  citationOpenStep,
  citationReveal,
  resolveCitationEntries,
  type CitationEntry,
  type CitationPassageNotice,
} from "./citationNavigationModel";
import { readScientSource } from "./client";
import type { LibraryCitationCandidate } from "./libraryCitations";
import { openLibrarySource } from "./librarySourceRequest";

export interface CitationOpenRequest {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly root: string;
  readonly candidates: ReadonlyArray<LibraryCitationCandidate>;
  readonly items: ReadonlyArray<CitationItem>;
  /** The quoted passage the citation ends, when it closes a quote ("Quote in my document"). */
  readonly quote?: string | null;
  /** Client coordinates of the click, for the choice between several sources. */
  readonly at: { readonly x: number; readonly y: number };
}

type SourceAttachment = ScientSourceDetailResult["attachments"][number];
type Notice = { readonly title: string; readonly description?: string };

const SHOWING_DETAILS = "Showing its details in the Library.";

/** A later citation click wins over one still reading its source. */
let latestOpen = 0;

/** Opens what a citation names. False when none of its keys is a Library source here. */
export function openCitation(request: CitationOpenRequest): boolean {
  const entries = resolveCitationEntries(request.candidates, request.items);
  const [first] = entries;
  if (!first) return false;
  const open = ++latestOpen;
  if (entries.length === 1) {
    void openEntry(request, first, open);
  } else {
    void chooseEntry(entries, request.at).then((entry) => {
      if (entry && open === latestOpen) return openEntry(request, entry, open);
    });
  }
  return true;
}

async function chooseEntry(
  entries: ReadonlyArray<CitationEntry>,
  at: CitationOpenRequest["at"],
): Promise<CitationEntry | null> {
  const api = readLocalApi();
  if (!api) return null;
  const items: ContextMenuItem[] = [
    { id: "choose", label: "Open which source?", header: true },
    ...entries.map((entry, index) => {
      const text = citationChoiceText(entry);
      return {
        id: String(index),
        label: text.label,
        ...(text.detail ? { detail: text.detail } : {}),
      };
    }),
  ];
  const chosen = await api.contextMenu.show(items, { x: at.x, y: at.y });
  return chosen === null ? null : (entries[Number(chosen)] ?? null);
}

function passageNotice(notice: CitationPassageNotice, showing: string): Notice {
  switch (notice) {
    case "not-found":
      return { title: "This passage is not among the source's highlights", description: showing };
    case "repeated":
      return { title: "This passage is highlighted more than once", description: showing };
    case "unread":
      return { title: "Couldn't read this source's highlights", description: showing };
  }
}

function sourcePdf(request: CitationOpenRequest, sourceId: string, attachment: SourceAttachment) {
  return workspacePdfSource({
    environmentId: request.environmentId,
    fileName: attachment.fileName,
    workspaceRoot: request.root,
    relativePath: `.scient/sources/${attachment.relativePath}`,
    origin: {
      _tag: "source",
      workspaceRoot: request.root,
      sourceId,
      attachmentId: attachment.attachmentId,
    },
  });
}

async function openEntry(
  request: CitationOpenRequest,
  entry: CitationEntry,
  open: number,
): Promise<void> {
  const { environmentId, root, threadRef } = request;
  const { sourceId } = entry.candidate;
  const showDetails = (notice: Notice | null) => {
    openLibrarySource({ threadRef, root, sourceId });
    if (notice) toastManager.add({ type: "info", ...notice });
  };
  const showPdf = (attachment: SourceAttachment) =>
    useRightPanelStore.getState().openScient(
      threadRef,
      scientSourcePdfSurface({
        sourceId,
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
      }),
    );

  const step = citationOpenStep(entry, request.quote ?? null);
  if (step._tag === "Details") {
    showDetails(
      step.noPdf ? { title: "This source has no PDF here", description: SHOWING_DETAILS } : null,
    );
    return;
  }
  // A disconnected environment throws before any request, so both reads start in a promise.
  const [detail, highlights] = await Promise.all([
    Promise.resolve()
      .then(() => readScientSource(environmentId, { root, sourceId }))
      .catch(() => null),
    step.quote === null
      ? []
      : Promise.resolve()
          .then(() => readSourceAnnotations(environmentId, { root, sourceId }))
          .then(
            (result) => result.attachments,
            () => null,
          ),
  ]);
  if (open !== latestOpen) return;
  const pdfs = detail?.attachments.filter((attachment) => attachment.kind === "pdf") ?? [];
  if (!detail || pdfs.length === 0) {
    showDetails({
      title: detail ? "This source has no PDF here" : "Couldn't read this source",
      description: SHOWING_DETAILS,
    });
    return;
  }
  const reveal = citationReveal(
    step,
    highlights &&
      highlights.filter((pdf) => pdfs.some((known) => known.attachmentId === pdf.attachmentId)),
  );
  switch (reveal._tag) {
    case "Details":
      showDetails(reveal.notice ? passageNotice(reveal.notice, SHOWING_DETAILS) : null);
      return;
    case "Page": {
      const attachment = pdfs.find((pdf) => pdf.attachmentId === step.pdf.attachmentId) ?? pdfs[0]!;
      requestPdfPageReveal(
        pdfRevealDocumentKey(sourcePdf(request, sourceId, attachment)),
        reveal.pageLabel,
      );
      showPdf(attachment);
      if (reveal.notice) {
        toastManager.add({
          type: "info",
          ...passageNotice(reveal.notice, `Showing page ${reveal.pageLabel}.`),
        });
      }
      return;
    }
    case "Highlight": {
      const attachment = pdfs.find((pdf) => pdf.attachmentId === reveal.attachmentId)!;
      const descriptor = sourcePdf(request, sourceId, attachment);
      const document = pdfDocumentIdentity(descriptor);
      if (document) {
        requestPdfReveal(
          pdfRevealDocumentKey(descriptor),
          PdfTarget.make({
            version: 1,
            document,
            material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
            extractor: reveal.annotation.anchor.extractor,
            selector: reveal.annotation.anchor.selector,
          }),
        );
      }
      showPdf(attachment);
    }
  }
}
