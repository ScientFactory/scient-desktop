import type { DocumentLease } from "../documentCache/documentCache";
import { acquirePdfDocument, type OpenedPdf } from "../pdf/pdfDocuments";

/** How long a quote waits for a PDF that is not open to give its page labels. */
const QUOTE_PAGE_LABELS_TIMEOUT_MS = 1_500;

/** A PDF's printed page labels: one per page, none defined, or not read. */
export type PdfPageLabels =
  | { readonly _tag: "Labels"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "None" }
  | { readonly _tag: "Unread" };

const UNREAD: PdfPageLabels = { _tag: "Unread" };

// By the PDF's content hash: labels never change for the same bytes. An unread PDF is not kept,
// so it is read again next time.
const labelsByContent = new Map<string, PdfPageLabels>();

/**
 * The printed page labels of a PDF no reader has open (pdf.js `getPageLabels()`). Opens it in the
 * shared pdf.js worker only for this and closes it after. Unread when it cannot be read within
 * `timeoutMs`.
 */
export async function readPdfPageLabels(input: {
  /** What the PDF's bytes are known by, such as its sha256. */
  readonly contentKey: string;
  /** A URL serving the PDF, minted on demand; null when it cannot be served. */
  readonly url: () => Promise<string | null>;
  readonly timeoutMs?: number;
}): Promise<PdfPageLabels> {
  const known = labelsByContent.get(input.contentKey);
  if (known) return known;
  const state: { finished: boolean; lease: DocumentLease<OpenedPdf> | null } = {
    finished: false,
    lease: null,
  };
  const read = async (): Promise<PdfPageLabels> => {
    const url = await input.url();
    if (state.finished || url === null) return UNREAD;
    const opened = acquirePdfDocument(null, url, {
      // A password-protected PDF is not asked for its password just to cite a page.
      onPassword: () => opened.release({ discard: true }),
      onProgress: () => undefined,
    });
    state.lease = opened;
    const { document } = await opened.value;
    const labels = await document.getPageLabels();
    const result: PdfPageLabels = labels ? { _tag: "Labels", labels } : { _tag: "None" };
    labelsByContent.set(input.contentKey, result);
    return result;
  };
  const timedOut = Promise.withResolvers<PdfPageLabels>();
  const timer = setTimeout(
    () => timedOut.resolve(UNREAD),
    input.timeoutMs ?? QUOTE_PAGE_LABELS_TIMEOUT_MS,
  );
  try {
    return await Promise.race([read().catch(() => UNREAD), timedOut.promise]);
  } finally {
    state.finished = true;
    clearTimeout(timer);
    // Unkept (no cache key): releasing closes the document, or stops it opening.
    state.lease?.release();
  }
}

/**
 * The printed page labels for citing a quote from a PDF no reader has open: one per page, or null,
 * so the quote keeps page numbers, when the PDF defines none or cannot be read in time.
 */
export async function readQuotePageLabels(
  input: Parameters<typeof readPdfPageLabels>[0],
): Promise<ReadonlyArray<string> | null> {
  const result = await readPdfPageLabels(input);
  return result._tag === "Labels" ? result.labels : null;
}
