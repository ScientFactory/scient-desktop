import { clampPdfPage } from "./pdfReaderModel";
import {
  normalizePdfReaderViewport,
  pdfReaderSessionStore,
  pdfReaderViewportFromLocation,
  restorePdfReaderViewport,
  type PdfReaderSessionStore,
  type PdfViewAreaLocation,
  type PdfViewportRestoreTarget,
} from "./pdfReaderSessionStore";

export interface PdfViewportSnapshotTarget {
  readonly currentPageNumber: number;
  readonly currentScale: number;
  readonly currentScaleValue: string;
  readonly pagesRotation: number;
}

export interface PdfReaderViewportSession {
  readonly restore: (target: PdfViewportRestoreTarget, pageCount: number) => number;
  readonly completeRestore: () => void;
  readonly updateFromViewArea: (
    location: PdfViewAreaLocation | null | undefined,
    scaleValueOverride?: string,
  ) => void;
  readonly snapshot: (target: PdfViewportSnapshotTarget, pageCount: number) => void;
  readonly flush: () => void;
}

/** Coordinates restore and view events so PDF.js cannot persist its transient initial layout. */
export function createPdfReaderViewportSession(input: {
  readonly documentKey: string;
  readonly store?: PdfReaderSessionStore;
}): PdfReaderViewportSession {
  const store = input.store ?? pdfReaderSessionStore;
  let acceptingViewUpdates = false;
  let latestViewport = store.get(input.documentKey).viewport;

  return {
    restore: (target, pageCount) => {
      acceptingViewUpdates = false;
      return restorePdfReaderViewport(target, latestViewport, pageCount);
    },
    completeRestore: () => {
      acceptingViewUpdates = true;
    },
    updateFromViewArea: (location, scaleValueOverride) => {
      if (!acceptingViewUpdates) return;
      const viewport = pdfReaderViewportFromLocation(
        location && scaleValueOverride !== undefined
          ? { ...location, scale: scaleValueOverride }
          : location,
      );
      if (viewport === null) return;
      latestViewport = viewport;
      store.updateViewport(input.documentKey, viewport);
    },
    snapshot: (target, pageCount) => {
      if (!acceptingViewUpdates) return;
      const page = clampPdfPage(target.currentPageNumber, pageCount);
      const viewport = normalizePdfReaderViewport({
        page,
        left: latestViewport?.page === page ? latestViewport.left : null,
        top: latestViewport?.page === page ? latestViewport.top : null,
        rotation: target.pagesRotation,
        scaleValue: target.currentScaleValue || String(target.currentScale),
      });
      if (viewport !== null) {
        latestViewport = viewport;
        store.updateViewport(input.documentKey, viewport);
      }
    },
    flush: store.flush,
  };
}
