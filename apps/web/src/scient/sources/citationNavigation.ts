import { PdfTarget } from "@scientfactory/document-artifacts";
import type { CitationItem } from "@scientfactory/scient-sources";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  type ContextMenuItem,
  type EnvironmentId,
  type ScientSourceDetailResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";

import { readSourceAnnotations } from "../annotations/client";
import { readPdfPageLabels, type PdfPageLabels } from "../annotations/pdfQuotePageLabels";
import {
  pdfRevealDocumentKey,
  requestPdfPageReveal,
  requestPdfReveal,
} from "../pdf/anchors/pdfRevealRequests";
import { pdfDocumentIdentity } from "../pdf/anchors/pdfTextTarget";
import { pdfSourceAssetResource, workspacePdfSource } from "../pdf/pdfSource";
import { scientSourcePdfSurface } from "../rightPanel/surfaces";
import {
  checkedCitationEntries,
  citationChoiceText,
  citationLabelsNeeded,
  citationOpenStep,
  citationReveal,
  resolveCitationEntries,
  type CitationEntry,
  type CitationNotice,
  type CitationPassageNotice,
} from "./citationNavigationModel";
import { readScientCitationKeys, readScientSource } from "./client";
import type { LibraryCitationCandidate } from "./libraryCitations";
import { openLibrarySource } from "./librarySourceRequest";

export interface CitationOpenRequest {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly root: string;
  /** The project-relative document holding the citation, whose bibliography decides what a key
   * names there; null when unknown, and the keys are taken as the project's. */
  readonly documentPath: string | null;
  readonly candidates: ReadonlyArray<LibraryCitationCandidate>;
  readonly items: ReadonlyArray<CitationItem>;
  /** The quoted passage the citation ends, when it closes a quote ("Quote in my document"). */
  readonly quote?: string | null;
  /** Client coordinates of the click, for the choice between several sources. */
  readonly at: { readonly x: number; readonly y: number };
}

type SourceAttachment = ScientSourceDetailResult["attachments"][number];

const SHOWING_DETAILS = msg("Showing its details in the Library.");

/** A later citation click wins over one still reading its source. */
let latestOpen = 0;

/**
 * Opens what a citation names. False when none of its keys is a Library key in this project.
 * Before anything opens, the keys are checked in the document's bibliography: a key it defines as
 * another work is left out, and nothing opens when every key is.
 */
export function openCitation(request: CitationOpenRequest): boolean {
  const entries = resolveCitationEntries(request.candidates, request.items);
  if (entries.length === 0) return false;
  const open = ++latestOpen;
  void checkEntries(request, entries).then(async (checked) => {
    if (open !== latestOpen) return;
    for (const notice of checked.notices) toastManager.add({ type: "info", ...notice });
    const [first] = checked.entries;
    if (!first) return;
    const entry =
      checked.entries.length === 1 ? first : await chooseEntry(checked.entries, request.at);
    if (entry && open === latestOpen) await openEntry(request, entry, open);
  });
  return true;
}

async function checkEntries(request: CitationOpenRequest, entries: ReadonlyArray<CitationEntry>) {
  const { environmentId, root, documentPath } = request;
  if (documentPath === null) return { entries, notices: [] };
  const keys = [...new Set(entries.map((entry) => entry.item.key))];
  // A disconnected environment throws before any request: the check failed.
  const resolved = await Promise.resolve()
    .then(() => readScientCitationKeys(environmentId, { root, path: documentPath, keys }))
    .then(
      (result) => result.keys,
      () => null,
    );
  return checkedCitationEntries(entries, resolved);
}

async function chooseEntry(
  entries: ReadonlyArray<CitationEntry>,
  at: CitationOpenRequest["at"],
): Promise<CitationEntry | null> {
  const api = readLocalApi();
  if (!api) return null;
  const items: ContextMenuItem[] = [
    { id: "choose", label: m(msg("Open which source?")), header: true },
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

function passageNotice(notice: CitationPassageNotice, showing: string): CitationNotice {
  switch (notice) {
    case "not-found":
      return {
        title: m(msg("This passage is not among the source's highlights")),
        description: showing,
      };
    case "repeated":
      return { title: m(msg("This passage is highlighted more than once")), description: showing };
    case "unread":
      return { title: m(msg("Couldn't read this source's highlights")), description: showing };
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

/** A URL serving a source's PDF, for reading its page labels; null when it cannot be served. */
async function sourcePdfUrl(
  environmentId: EnvironmentId,
  descriptor: ReturnType<typeof sourcePdf>,
): Promise<string | null> {
  const connection = readPreparedConnection(environmentId);
  const resource = pdfSourceAssetResource(descriptor);
  if (connection === null || resource === null) return null;
  if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return null;
  const issued = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({ environmentId, input: { resource } }),
    { reportFailure: false, reportDefect: false, refresh: true },
  );
  if (issued._tag === "Failure") return null;
  return resolveAssetUrl(connection.httpBaseUrl, issued.value.relativeUrl);
}

async function openEntry(
  request: CitationOpenRequest,
  entry: CitationEntry,
  open: number,
): Promise<void> {
  const { environmentId, root, threadRef } = request;
  const { sourceId } = entry.candidate;
  const showDetails = (notice: CitationNotice | null) => {
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
      step.noPdf
        ? { title: m(msg("This source has no PDF here")), description: m(SHOWING_DETAILS) }
        : null,
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
      title: detail ? m(msg("This source has no PDF here")) : m(msg("Couldn't read this source")),
      description: m(SHOWING_DETAILS),
    });
    return;
  }
  const known =
    highlights &&
    highlights.filter((pdf) => pdfs.some((known) => known.attachmentId === pdf.attachmentId));
  // Several highlights with the quoted words are told apart by the printed page of each.
  const labels = new Map<string, PdfPageLabels>(
    await Promise.all(
      citationLabelsNeeded(step, known).map(async (attachmentId) => {
        const attachment = pdfs.find((pdf) => pdf.attachmentId === attachmentId)!;
        const descriptor = sourcePdf(request, sourceId, attachment);
        const read = await readPdfPageLabels({
          contentKey: attachment.sha256,
          url: () => sourcePdfUrl(environmentId, descriptor),
        });
        return [attachmentId, read] as const;
      }),
    ),
  );
  if (open !== latestOpen) return;
  const reveal = citationReveal(step, known, labels);
  switch (reveal._tag) {
    case "Details":
      showDetails(reveal.notice ? passageNotice(reveal.notice, m(SHOWING_DETAILS)) : null);
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
          ...passageNotice(
            reveal.notice,
            m(msg("Showing page {page}.", { page: reveal.pageLabel })),
          ),
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
