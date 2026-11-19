import {
  documentCache,
  type DocumentKind,
  type DocumentLease,
} from "../documentCache/documentCache";
import { startPdfDocumentLoad, type PdfLoadCallbacks, type PDFDocumentProxy } from "./pdfRuntime";

/** A PDF opened by pdf.js: parsed in the shared worker, with no viewer of its own. */
export interface OpenedPdf {
  readonly document: PDFDocumentProxy;
  readonly close: () => Promise<void>;
  /** The file's length once pdf.js has all of it. */
  bytes: number | null;
}

const MB = 1024 * 1024;

const pdfKind: DocumentKind<OpenedPdf> = {
  dispose: (pdf) => void pdf.close().catch(() => undefined),
  // Measured in the desktop app: about 40 MB, and 12 times the file for its parsed structure.
  size: (pdf) => (pdf.bytes === null ? 64 * MB : 40 * MB + pdf.bytes * 12),
  idle: (pdf) => {
    void Promise.resolve()
      .then(() => pdf.document.cleanup())
      .catch(() => undefined);
  },
};

/**
 * Leases the PDF at `key` (null for one that must not be kept, such as an edited copy),
 * opening it from `url` unless a reader left it recently. `callbacks` report a password or
 * progress for a PDF that opens now.
 */
export function acquirePdfDocument(
  key: string | null,
  url: string,
  callbacks: PdfLoadCallbacks,
): DocumentLease<OpenedPdf> {
  return documentCache.acquire(
    key,
    (signal) => {
      const task = startPdfDocumentLoad(url, callbacks);
      signal.addEventListener("abort", () => void task.destroy().catch(() => undefined), {
        once: true,
      });
      return task.promise.then((document) => {
        const opened: OpenedPdf = { document, close: () => task.destroy(), bytes: null };
        void document.getDownloadInfo().then(
          ({ length }) => {
            opened.bytes = length;
          },
          () => undefined,
        );
        return opened;
      });
    },
    pdfKind,
  );
}
