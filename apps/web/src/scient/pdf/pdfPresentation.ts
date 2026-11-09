import type { ScientPdfRuntime } from "./pdfRuntime";

// pdf.js's own visible-page query, a search over page positions; its declaration says `object`.
interface VisiblePages {
  readonly views: readonly {
    readonly id: number;
    readonly view: { readonly renderingState: number; readonly textLayer: unknown };
  }[];
}

/** A sized, invisible staging surface, not display:none (PDF.js needs layout). */
export function createPdfPresentationLayer(mount: HTMLElement) {
  const container = document.createElement("div");
  container.className = "scient-pdf-viewer-container scient-pdf-staging";
  container.setAttribute("aria-hidden", "true");
  container.inert = true;
  const viewerElement = document.createElement("div");
  viewerElement.className = "pdfViewer";
  container.append(viewerElement);
  mount.append(container);
  return { container, viewerElement };
}

/**
 * Keep the old surface intact until the replacement's actual visible canvases
 * and text layers are ready. Follow scrolling/zooming during preparation; never
 * restore a viewport captured seconds ago over a user's newer navigation.
 */
export function preparePdfPresentation(input: {
  runtime: ScientPdfRuntime;
  container: HTMLDivElement;
  current: () => { runtime: ScientPdfRuntime; container: HTMLDivElement } | null;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    let navigation = "";
    let stableFrames = 0;
    let settled = false;
    const textReady = new Set<number>();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      input.runtime.eventBus.off("textlayerrendered", onText);
      input.runtime.eventBus.off("pagerendered", onPage);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new DOMException("Presentation superseded", "AbortError"));
    const onText = ({ pageNumber, error }: { pageNumber: number; error?: unknown }) => {
      if (error) finish(new Error("The updated PDF text layer could not be rendered."));
      else textReady.add(pageNumber);
    };
    const onPage = ({ error }: { error?: unknown }) => {
      if (error) finish(new Error("The updated PDF page could not be rendered."));
    };
    const timeout = setTimeout(
      () =>
        finish(new Error("The updated PDF is not ready. The previous page is still available.")),
      30_000,
    );
    const tick = () => {
      if (settled) return;
      if (input.signal.aborted) return abort();
      const displayed = input.current();
      const viewer = input.runtime.viewer;
      const container = input.container;
      if (displayed) {
        const live = displayed.runtime.viewer;
        const signature = [
          displayed.container.scrollTop,
          displayed.container.scrollLeft,
          live.currentScale,
          live.pagesRotation,
          container.clientWidth,
          container.clientHeight,
        ].join(":");
        if (
          viewer.pagesRotation !== live.pagesRotation ||
          viewer.currentScale !== live.currentScale
        ) {
          textReady.clear();
          stableFrames = 0;
          viewer.pagesRotation = live.pagesRotation;
          viewer.currentScale = live.currentScale;
        }
        if (signature !== navigation) {
          navigation = signature;
          stableFrames = 0;
          // Explicit scale avoids a second auto-fit transition at publication.
          container.scrollTop = displayed.container.scrollTop;
          container.scrollLeft = displayed.container.scrollLeft;
        }
      }
      viewer.update();
      const { views } = viewer._getVisiblePages() as VisiblePages;
      const ready =
        views.length > 0 &&
        views.every(
          // PDF.js FINISHED=3. pagesinit only creates placeholders; it is not a paint fence.
          ({ id, view }) => view.renderingState === 3 && (!view.textLayer || textReady.has(id)),
        );
      stableFrames = ready ? stableFrames + 1 : 0;
      if (stableFrames >= 2) return finish();
      frame = requestAnimationFrame(tick);
    };
    input.runtime.eventBus.on("textlayerrendered", onText);
    input.runtime.eventBus.on("pagerendered", onPage);
    input.signal.addEventListener("abort", abort, { once: true });
    frame = requestAnimationFrame(tick);
  });
}
