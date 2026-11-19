import type { ScientPdfRuntime } from "./pdfRuntime";

// pdf.js RenderingStates. Importing its viewer here would need pdf.js loaded first.
const INITIAL = 0;
const FINISHED = 3;

const THUMBNAIL_WIDTH = 132;

// The parts of pdf.js's rendering queue its own sidebar uses. Its declaration types the sidebar
// as a full PDFThumbnailViewer and requires the visible pages, which the sidebar never passes.
interface RenderingQueue {
  isThumbnailViewEnabled: boolean;
  setThumbnailViewer(viewer: { forceRendering(): boolean }): void;
  renderHighestPriority(visiblePages?: object): void;
}

type Job = () => Promise<void>;

const queues = new WeakMap<ScientPdfRuntime, { add(job: Job): () => void }>();

/**
 * Thumbnails take their turn in pdf.js's rendering queue, as in pdf.js's own sidebar: one at a
 * time, and only once the pages in view are drawn.
 */
function thumbnailQueue(runtime: ScientPdfRuntime) {
  let queue = queues.get(runtime);
  if (queue) return queue;
  const rendering = runtime.viewer.renderingQueue as unknown as RenderingQueue;
  const pending = new Set<Job>();
  let running = false;
  rendering.isThumbnailViewEnabled = true;
  rendering.setThumbnailViewer({
    forceRendering() {
      if (running) return true;
      const job = pending.values().next().value;
      if (!job) return false;
      pending.delete(job);
      running = true;
      void job().finally(() => {
        running = false;
        rendering.renderHighestPriority();
      });
      return true;
    },
  });
  queue = {
    add(job) {
      pending.add(job);
      rendering.renderHighestPriority();
      return () => pending.delete(job);
    },
  };
  queues.set(runtime, queue);
  return queue;
}

function show(target: HTMLCanvasElement, source: HTMLCanvasElement, cssHeight: number) {
  target.width = source.width;
  target.height = source.height;
  target.style.width = `${THUMBNAIL_WIDTH}px`;
  target.style.height = `${Math.round(cssHeight)}px`;
  target.getContext("2d", { alpha: false })?.drawImage(source, 0, 0);
}

/** Draws a page's thumbnail into `target`; the returned function cancels it. */
export function drawPdfThumbnail(
  runtime: ScientPdfRuntime,
  pageNumber: number,
  rotation: number,
  target: HTMLCanvasElement,
  onFailure: () => void,
): () => void {
  const pageView = runtime.viewer.getPageView(pageNumber - 1);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  // A page the reader has drawn is copied, not drawn a second time.
  const drawn: unknown = pageView?.canvas;
  // A page past the canvas limit takes a new rotation as a CSS transform over its old drawing.
  if (
    pageView?.renderingState === FINISHED &&
    drawn instanceof HTMLCanvasElement &&
    !drawn.style.transform
  ) {
    const height = (drawn.height / drawn.width) * THUMBNAIL_WIDTH;
    const copy = document.createElement("canvas");
    copy.width = Math.round(THUMBNAIL_WIDTH * pixelRatio);
    copy.height = Math.max(1, Math.round(height * pixelRatio));
    copy.getContext("2d", { alpha: false })?.drawImage(drawn, 0, 0, copy.width, copy.height);
    show(target, copy, height);
    return () => {};
  }
  let current = true;
  let cancelRender: (() => void) | null = null;
  const remove = thumbnailQueue(runtime).add(async () => {
    if (!current) return;
    try {
      const page = await runtime.document.getPage(pageNumber);
      try {
        if (!current) return;
        const pageRotation = page.rotate + rotation;
        const unscaled = page.getViewport({ scale: 1, rotation: pageRotation });
        const viewport = page.getViewport({
          scale: (THUMBNAIL_WIDTH / unscaled.width) * pixelRatio,
          rotation: pageRotation,
        });
        // Drawn off screen and copied in whole: resizing the shown canvas clears it to black
        // until pdf.js finishes, which flashed every thumbnail after an edit.
        const offscreen = document.createElement("canvas");
        offscreen.width = Math.max(1, Math.floor(viewport.width));
        offscreen.height = Math.max(1, Math.floor(viewport.height));
        const context = offscreen.getContext("2d", { alpha: false });
        if (!context) return;
        const task = page.render({ canvas: offscreen, canvasContext: context, viewport });
        cancelRender = () => task.cancel();
        await task.promise;
        if (current) show(target, offscreen, viewport.height / pixelRatio);
      } finally {
        // Resources the main view still draws from stay loaded.
        if (runtime.viewer.getPageView(pageNumber - 1)?.renderingState === INITIAL) page.cleanup();
      }
    } catch (error) {
      if (current && !(error instanceof Error && error.name === "RenderingCancelledException"))
        onFailure();
    }
  });
  return () => {
    current = false;
    remove();
    cancelRender?.();
  };
}
