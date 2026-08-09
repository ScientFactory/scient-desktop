import { useEffect, useRef, useState } from "react";

import type { ScientPdfRuntime } from "./pdfRuntime";

export function PdfThumbnail(props: {
  readonly active: boolean;
  readonly pageNumber: number;
  readonly runtime: ScientPdfRuntime;
  readonly onSelect: (page: number) => void;
}) {
  const rootRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { root: root.parentElement, rootMargin: "240px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let current = true;
    let cancelRender: (() => void) | null = null;
    let loadedPage: Awaited<ReturnType<typeof props.runtime.document.getPage>> | null = null;
    setFailed(false);
    void props.runtime.document
      .getPage(props.pageNumber)
      .then((page) => {
        loadedPage = page;
        if (!current) return;
        const unscaled = page.getViewport({
          scale: 1,
          rotation: props.runtime.viewer.pagesRotation,
        });
        const cssWidth = 132;
        const cssScale = cssWidth / unscaled.width;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({
          scale: cssScale * pixelRatio,
          rotation: props.runtime.viewer.pagesRotation,
        });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${Math.round(viewport.height / pixelRatio)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;
        const task = page.render({ canvas, canvasContext: context, viewport });
        cancelRender = () => task.cancel();
        return task.promise.catch((error: unknown) => {
          if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
            throw error;
          }
        });
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
      cancelRender?.();
      loadedPage?.cleanup();
    };
  }, [props.pageNumber, props.runtime, props.runtime.viewer.pagesRotation, visible]);

  return (
    <button
      ref={rootRef}
      type="button"
      className="scient-pdf-thumbnail"
      data-active={props.active || undefined}
      aria-label={`Go to page ${props.pageNumber}`}
      aria-current={props.active ? "page" : undefined}
      onClick={() => props.onSelect(props.pageNumber)}
    >
      <span className="scient-pdf-thumbnail-canvas">
        {failed ? (
          <span className="text-[10px] text-muted-foreground">Preview unavailable</span>
        ) : null}
        <canvas ref={canvasRef} className={failed ? "hidden" : undefined} aria-hidden="true" />
      </span>
      <span>{props.pageNumber}</span>
    </button>
  );
}
