import type { ScientPdfRuntime } from "./pdfRuntime";

/** Geometry-only extension. It never authorizes source edits. */
export interface PdfPresentationAnchor {
  readonly key: string;
  readonly screenTop: number;
  readonly locate: (container: HTMLElement) => number | null;
  readonly locatePage?: (
    document: ScientPdfRuntime["document"],
    signal: AbortSignal,
  ) => Promise<number | null>;
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
  captureAnchor: () => PdfPresentationAnchor | null;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    let navigation = "";
    let stableFrames = 0;
    let anchorKey = "";
    let anchored = false;
    let settled = false;
    let searching = false;
    let searched = false;
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
          anchored = false;
          // Explicit scale avoids a second auto-fit transition at publication.
          container.scrollTop = displayed.container.scrollTop;
          container.scrollLeft = displayed.container.scrollLeft;
        }
      }
      viewer.update();
      const anchor = input.captureAnchor();
      if ((anchor?.key ?? "") !== anchorKey) {
        anchorKey = anchor?.key ?? "";
        anchored = false;
        stableFrames = 0;
        searching = false;
        searched = false;
      }
      if (anchor && !anchored) {
        const top = anchor.locate(container);
        if (top !== null) {
          container.scrollTop += top - anchor.screenTop;
          anchored = true;
          stableFrames = 0;
          viewer.update();
        }
      }
      const top = container.scrollTop;
      const bottom = top + container.clientHeight;
      const visible = Array.from(
        container.querySelectorAll<HTMLElement>(".page[data-page-number]"),
      ).filter((page) => page.offsetTop < bottom && page.offsetTop + page.clientHeight > top);
      const ready =
        visible.length > 0 &&
        visible.every((page) => {
          const number = Number(page.dataset.pageNumber);
          const view = viewer.getPageView(number - 1);
          // PDF.js FINISHED=3. pagesinit only creates placeholders; it is not a paint fence.
          return view?.renderingState === 3 && (!view.textLayer || textReady.has(number));
        });
      // A reflow can move the source anchor onto an adjacent page whose text
      // layer has not been virtualized in yet. Locate that page from PDF text,
      // then prepare it before applying the screen-position compensation.
      if (ready && anchor?.locatePage && !anchored && !searching && !searched) {
        searching = true;
        const key = anchorKey;
        void anchor.locatePage(input.runtime.document, input.signal).then(
          (page) => {
            if (settled || key !== anchorKey) return;
            searching = false;
            searched = true;
            stableFrames = 0;
            if (page !== null && page !== viewer.currentPageNumber) viewer.currentPageNumber = page;
          },
          () => {
            if (settled || key !== anchorKey) return;
            searching = false;
            searched = true;
          },
        );
      }
      stableFrames = ready && !searching ? stableFrames + 1 : 0;
      if (stableFrames >= 2) return finish();
      frame = requestAnimationFrame(tick);
    };
    input.runtime.eventBus.on("textlayerrendered", onText);
    input.runtime.eventBus.on("pagerendered", onPage);
    input.signal.addEventListener("abort", abort, { once: true });
    frame = requestAnimationFrame(tick);
  });
}
