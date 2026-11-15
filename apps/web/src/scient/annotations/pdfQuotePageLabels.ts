import type { DocumentLease } from "../documentCache/documentCache";
import { acquirePdfDocument, type OpenedPdf } from "../pdf/pdfDocuments";

/** How long a quote waits for a PDF that is not open to give its page labels. */
const QUOTE_PAGE_LABELS_TIMEOUT_MS = 1_500;

// By the PDF's content hash: labels never change for the same bytes.
const labelsByContent = new Map<string, ReadonlyArray<string> | null>();

/**
 * The printed page labels of a PDF no reader has open, for citing a quote from
 * it (pdf.js `getPageLabels()`: one per page, or null when the PDF defines none).
 * Opens it in the shared pdf.js worker only for this and closes it after. Null,
 * so the quote keeps page numbers, when it cannot be read within `timeoutMs`.
 */
export async function readQuotePageLabels(input: {
  /** What the PDF's bytes are known by, such as its sha256. */
  readonly contentKey: string;
  /** A URL serving the PDF, minted on demand; null when it cannot be served. */
  readonly url: () => Promise<string | null>;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<string> | null> {
  if (labelsByContent.has(input.contentKey)) return labelsByContent.get(input.contentKey) ?? null;
  const state: { finished: boolean; lease: DocumentLease<OpenedPdf> | null } = {
    finished: false,
    lease: null,
  };
  const read = async () => {
    const url = await input.url();
    if (state.finished || url === null) return null;
    const opened = acquirePdfDocument(null, url, {
      // A password-protected PDF is not asked for its password just to cite a page.
      onPassword: () => opened.release({ discard: true }),
      onProgress: () => undefined,
    });
    state.lease = opened;
    const { document } = await opened.value;
    const labels = await document.getPageLabels();
    labelsByContent.set(input.contentKey, labels);
    return labels;
  };
  const timedOut = Promise.withResolvers<null>();
  const timer = setTimeout(
    () => timedOut.resolve(null),
    input.timeoutMs ?? QUOTE_PAGE_LABELS_TIMEOUT_MS,
  );
  try {
    return await Promise.race([read().catch(() => null), timedOut.promise]);
  } finally {
    state.finished = true;
    clearTimeout(timer);
    // Unkept (no cache key): releasing closes the document, or stops it opening.
    state.lease?.release();
  }
}
