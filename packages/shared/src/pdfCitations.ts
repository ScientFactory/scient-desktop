import { PdfCitation, pdfCitationText } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * PDF quotes in prompt text: `[PDF quote](scient-pdf-citation://v1/?data=…)`.
 * Kept apart from file quotes so each kind owns its link format and budget.
 */
export const PDF_CITATION_PROTOCOL = "scient-pdf-citation";
const PREFIX = `${PDF_CITATION_PROTOCOL}://v1/`;
/**
 * A new quote's link must fit this many characters, so that its comment (up to
 * 8,000 characters, up to nine encoded characters each) still leaves the
 * message within its limit.
 */
export const PDF_CITATION_CAPTURE_BUDGET = 40_000;
/** The longest link read back, as for file quotes: a long comment never makes a quote unreadable. */
const PDF_CITATION_MAX_HREF_LENGTH = 240_000;
// Generated URLs encode parentheses; a raw one ends the scan early.
export const PDF_CITATION_LINK =
  /\[PDF quote\]\((scient-pdf-citation:\/\/v1\/[^\s()]{1,240000})\)/g;
const decodePdf = Schema.decodeUnknownOption(PdfCitation);

export function formatPdfCitationHref(citation: PdfCitation): string {
  return `${PREFIX}?${new URLSearchParams({ data: JSON.stringify(citation) })}`;
}

export function serializePdfCitation(citation: PdfCitation): string {
  return `[PDF quote](${formatPdfCitationHref(citation)})`;
}

/** Whether a new quote fits its capture budget. */
export function pdfCitationFits(citation: PdfCitation): boolean {
  return formatPdfCitationHref(citation).length <= PDF_CITATION_CAPTURE_BUDGET;
}

export function parsePdfCitationHref(href: string): PdfCitation | null {
  if (!href.startsWith(PREFIX) || href.length > PDF_CITATION_MAX_HREF_LENGTH) return null;
  try {
    const url = new URL(href);
    if (
      url.origin !== "null" ||
      url.protocol !== `${PDF_CITATION_PROTOCOL}:` ||
      url.hostname !== "v1" ||
      url.pathname !== "/" ||
      url.hash ||
      url.port ||
      url.username ||
      url.password ||
      url.searchParams.size !== 1 ||
      !url.searchParams.has("data")
    )
      return null;
    return Option.getOrNull(decodePdf(JSON.parse(url.searchParams.get("data")!)));
  } catch {
    return null;
  }
}

/** "p. 3" or "pp. 3–4". */
export function pdfCitationPages(citation: PdfCitation): string {
  const pages = citation.target.selector.pages;
  const first = pages[0]!.page;
  const last = pages.at(-1)!.page;
  return first === last ? `p. ${first}` : `pp. ${first}–${last}`;
}

export function pdfCitationLabel(citation: PdfCitation): string {
  const preview = (citation.comment?.trim() || pdfCitationText(citation)).replace(/\s+/g, " ");
  const excerpt = preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
  return `${citation.target.document.fileName} · ${pdfCitationPages(citation)} · ${excerpt}`;
}

/** Where the PDF is, in words an agent or a reader can use. */
export function pdfCitationDocumentLabel(citation: PdfCitation): string {
  const { document } = citation.target;
  switch (document.locator._tag) {
    case "workspace":
    case "source":
      return document.locator.relativePath;
    case "environment":
      return document.locator.path;
    case "generated":
      return `${document.title} (generated PDF)`;
    case "attachment":
      return `${document.fileName} (chat attachment)`;
  }
}

/**
 * The document as the agent can use it, with the environment it belongs to:
 * paths name that environment's files, as file quotes' paths do, never this one's.
 */
function agentDocument(citation: PdfCitation) {
  const { document } = citation.target;
  const locator = document.locator;
  const environmentId = document.authority;
  switch (locator._tag) {
    case "workspace":
      return {
        type: "workspace" as const,
        environmentId,
        workspaceRoot: locator.workspaceRoot,
        path: locator.relativePath,
      };
    case "source":
      return {
        type: "source" as const,
        environmentId,
        workspaceRoot: locator.workspaceRoot,
        path: locator.relativePath,
        sourceId: locator.sourceId,
      };
    case "generated":
      return {
        type: "generated" as const,
        environmentId,
        title: document.title,
        artifactId: locator.artifactId,
      };
    case "attachment":
      return { type: "attachment" as const, environmentId, name: document.fileName };
    case "environment":
      return { type: "environment" as const, environmentId, path: locator.path };
  }
}

/**
 * What the agent sees for a PDF quote: the document, the page(s) and the
 * text, with a little context. Hashes and offsets stay in the stored quote.
 */
export function pdfCitationForProvider(citation: PdfCitation) {
  const pages = citation.target.selector.pages;
  return {
    kind: "pdf" as const,
    document: agentDocument(citation),
    revision: citation.target.material === null ? ("unverified" as const) : ("exact" as const),
    selection: "text" as const,
    pages: pages.map((page) => ({ page: page.page, text: page.quote })),
    before: pages[0]!.prefix,
    after: pages.at(-1)!.suffix,
    ...(citation.comment === undefined ? {} : { comment: citation.comment }),
  };
}

export const PDF_CITATION_PROVIDER_NOTE =
  "PDF quotes give the page and the text as Scient's PDF reader extracted it, with up to 64 characters before and after. The PDF may have changed since the quote was taken.";
