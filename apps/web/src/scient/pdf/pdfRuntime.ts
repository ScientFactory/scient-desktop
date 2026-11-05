import {
  AnnotationEditorType,
  AnnotationMode,
  GlobalWorkerOptions,
  PasswordResponses,
  PDFWorker,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  EventBus,
  FindState,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

import { observeResize } from "~/lib/observeResize";

import { createPdfResizeSettlement } from "./pdfResizeSettlement";
import { prioritizePdfWork } from "./pdfChatPriority";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Without a shared worker, pdf.js starts a worker and recompiles its 1.3 MB
// script for every document, about 80 ms per open. Destroying a document
// leaves a worker the caller supplied running.
let sharedWorker: PDFWorker | undefined;

// pdf.js tracks worker failures only while the worker starts, so a worker that later reports an
// error is retired here: the next PDF opens on a fresh worker instead of one that cannot answer.
function acquireSharedWorker(): PDFWorker {
  if (sharedWorker !== undefined && !sharedWorker.destroyed) return sharedWorker;
  const worker = new PDFWorker();
  sharedWorker = worker;
  const retire = () => {
    if (sharedWorker === worker) sharedWorker = undefined;
    worker.destroy();
  };
  worker.promise.then(() => worker.port?.addEventListener("error", retire), retire);
  return worker;
}

export type PdfPasswordReason = "required" | "incorrect";

export interface PdfPasswordChallenge {
  readonly reason: PdfPasswordReason;
  readonly submit: (password: string) => void;
}

export interface PdfLoadCallbacks {
  readonly onPassword: (challenge: PdfPasswordChallenge) => void;
  readonly onProgress: (loaded: number, total: number | null) => void;
}

export interface PDFOutlineItem {
  readonly title: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly dest: string | Array<unknown> | null;
  readonly url: string | null;
  readonly items: Array<PDFOutlineItem>;
}

export type PDFOutline = Array<PDFOutlineItem>;

export interface ScientPdfRuntime {
  readonly document: PDFDocumentProxy;
  readonly eventBus: EventBus;
  readonly findController: PDFFindController;
  readonly linkService: PDFLinkService;
  readonly loadingTask: PDFDocumentLoadingTask;
  readonly viewer: PDFViewer;
  cancelContainerSizeRefresh: () => void;
  destroy: () => Promise<void>;
  refreshForContainerSize: () => void;
}

function pdfAssetRoot(): string {
  return new URL(`${import.meta.env.BASE_URL}pdfjs-assets/`, window.location.href).toString();
}

export function startPdfDocumentLoad(
  url: string,
  callbacks: PdfLoadCallbacks,
): PDFDocumentLoadingTask {
  const assetRoot = pdfAssetRoot();
  const loadingTask = getDocument({
    url,
    worker: acquireSharedWorker(),
    cMapPacked: true,
    cMapUrl: `${assetRoot}cmaps/`,
    standardFontDataUrl: `${assetRoot}standard_fonts/`,
    wasmUrl: `${assetRoot}wasm/`,
    enableXfa: true,
    useSystemFonts: true,
    disableAutoFetch: false,
    disableRange: false,
    disableStream: false,
    rangeChunkSize: 256 * 1024,
  });
  loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    callbacks.onPassword({
      reason: reason === PasswordResponses.INCORRECT_PASSWORD ? "incorrect" : "required",
      submit: updatePassword,
    });
  };
  loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
    callbacks.onProgress(loaded, total > 0 ? total : null);
  };
  return loadingTask;
}

export function createPdfRuntime(input: {
  readonly container: HTMLDivElement;
  readonly document: PDFDocumentProxy;
  readonly loadingTask: PDFDocumentLoadingTask;
  readonly onContainerResize?: ((viewer: PDFViewer) => void) | undefined;
  readonly sourceUrl: string;
  readonly viewerElement: HTMLDivElement;
}): ScientPdfRuntime {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: "noopener noreferrer nofollow",
    ignoreDestinationZoom: false,
  });
  const findController = new PDFFindController({
    eventBus,
    linkService,
    delay: 100,
    updateMatchesCountOnProgress: true,
  });
  const viewerLifetime = new AbortController();
  const viewerOptions = {
    // Supported by the pinned PDF.js runtime (its generated declaration omits
    // this option). Releases its internal scroll and resize observers on swap.
    abortSignal: viewerLifetime.signal,
    container: input.container,
    viewer: input.viewerElement,
    eventBus,
    linkService,
    findController,
    annotationMode: AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: AnnotationEditorType.NONE,
    enableAutoLinking: true,
    enableDetailCanvas: true,
    enableOptimizedPartialRendering: true,
    enablePermissions: true,
    enablePrintAutoRotate: true,
    enableSelectionRendering: true,
    imageResourcesPath: `${pdfAssetRoot()}images/`,
    maxCanvasDim: 8_192,
    maxCanvasPixels: 16_777_216,
    // Page margins come from the container's border; see scientPdfReader.css.
    removePageBorders: true,
    supportsPinchToZoom: true,
  };
  const viewer = new PDFViewer(viewerOptions);
  prioritizePdfWork(viewer, viewerLifetime.signal);

  linkService.setViewer(viewer);
  linkService.setDocument(input.document);
  findController.setDocument(input.document);
  viewer.setDocument(input.document);

  let destroyed = false;
  const resizeSettlement = createPdfResizeSettlement(() => {
    if (destroyed) return;
    if (input.onContainerResize) {
      input.onContainerResize(viewer);
      return;
    }
    if (viewer.currentScaleValue === "page-width" || viewer.currentScaleValue === "page-fit") {
      const scaleMode = viewer.currentScaleValue;
      viewer.currentScaleValue = scaleMode;
    } else {
      viewer.update();
    }
  });
  const refreshForContainerSize = () => {
    if (!destroyed) resizeSettlement.schedule();
  };
  let observedWidth = input.container.getBoundingClientRect().width;
  const stopResize = observeResize(
    input.container,
    () => {
      const nextWidth = input.container.getBoundingClientRect().width;
      if (Math.abs(nextWidth - observedWidth) < 0.5) return;
      observedWidth = nextWidth;
      refreshForContainerSize();
    },
    { box: "border-box" },
  );

  return {
    document: input.document,
    eventBus,
    findController,
    linkService,
    loadingTask: input.loadingTask,
    viewer,
    cancelContainerSizeRefresh: resizeSettlement.cancel,
    refreshForContainerSize,
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      viewerLifetime.abort();
      stopResize();
      resizeSettlement.cancel();
      viewer.cleanup();
      // PDF.js supports null to reset/cancel its page views; its declaration
      // currently omits that runtime-supported branch.
      (viewer.setDocument as (document: PDFDocumentProxy | null) => void)(null);
      input.viewerElement.replaceChildren();
      await input.loadingTask.destroy();
    },
  };
}

export { FindState };
export type { PDFDocumentProxy };
