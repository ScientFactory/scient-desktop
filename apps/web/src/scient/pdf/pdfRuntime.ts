import {
  AnnotationEditorType,
  AnnotationMode,
  GlobalWorkerOptions,
  PasswordResponses,
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

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
  destroy: () => Promise<void>;
}

export type PdfJsFindState = (typeof FindState)[keyof typeof FindState];

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
  const viewer = new PDFViewer({
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
    removePageBorders: false,
    supportsPinchToZoom: true,
  });

  linkService.setViewer(viewer);
  linkService.setDocument(input.document);
  findController.setDocument(input.document);
  viewer.setDocument(input.document);

  let resizeFrame: number | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (viewer.currentScaleValue === "page-width" || viewer.currentScaleValue === "page-fit") {
        const scaleMode = viewer.currentScaleValue;
        viewer.currentScaleValue = scaleMode;
      } else {
        viewer.update();
      }
    });
  });
  resizeObserver.observe(input.container);

  let destroyed = false;
  return {
    document: input.document,
    eventBus,
    findController,
    linkService,
    loadingTask: input.loadingTask,
    viewer,
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      resizeObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      viewer.cleanup();
      input.viewerElement.replaceChildren();
      await input.loadingTask.destroy();
    },
  };
}

export { FindState };
export type { PDFDocumentProxy };
