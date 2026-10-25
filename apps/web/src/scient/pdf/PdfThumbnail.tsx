import { useEffect, useRef, useState } from "react";
import type { ScientPdfRuntime } from "./pdfRuntime";
import { ReaderPageThumbnail } from "../writing/ReaderPageThumbnail";
import { startPdfPageDragFollow } from "./pdfPageDragImage";

let stopDragScroll: (() => void) | null = null;
function startDragScroll(container: HTMLElement) {
  stopDragScroll?.();
  let frame = 0,
    x = 0,
    y = 0,
    previous = 0;
  const track = (event: DragEvent) => {
    x = event.clientX;
    y = event.clientY;
  };
  const tick = (now: number) => {
    const r = container.getBoundingClientRect();
    const dt = previous ? Math.min(now - previous, 32) : 16;
    previous = now;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const edge = 48;
      const speed =
        y < r.top + edge
          ? -9 * (1 - (y - r.top) / edge)
          : y > r.bottom - edge
            ? 9 * (1 - (r.bottom - y) / edge)
            : 0;
      if (speed) container.scrollTop += (speed * dt) / 16;
    }
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("dragover", track);
    document.removeEventListener("drop", stop);
    document.removeEventListener("dragend", stop);
    stopDragScroll = null;
  };
  document.addEventListener("dragover", track);
  document.addEventListener("drop", stop);
  document.addEventListener("dragend", stop);
  frame = requestAnimationFrame(tick);
  stopDragScroll = stop;
}

/**
 * Reports the dragged pages once the drag has started, so they fade after the browser has
 * begun it, and clears them when it ends: dropped here, elsewhere, or cancelled.
 */
function trackPageDrag(
  pages: readonly string[],
  report?: (pages: readonly string[] | null) => void,
) {
  if (!report) return;
  const frame = requestAnimationFrame(() => report(pages));
  const end = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("dragend", end, true);
    document.removeEventListener("drop", end, true);
    report(null);
  };
  document.addEventListener("dragend", end, true);
  document.addEventListener("drop", end, true);
}

export function PdfThumbnail(props: {
  readonly active: boolean;
  readonly pageNumber: number;
  readonly runtime: ScientPdfRuntime;
  readonly editable?: boolean;
  readonly onSelect: (page: number) => void;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly dragScope: string;
  readonly dragPages: readonly string[];
  readonly onToggle: (page: number, shiftKey: boolean) => void;
  readonly onContext: (
    page: number,
    position: { x: number; y: number },
    anchor: HTMLElement,
  ) => void;
  readonly onMove: (boundary: number, pages: readonly string[]) => void;
  /** True while this page is among the dragged ones; it stays in place, faded. */
  readonly dragged?: boolean;
  readonly onDragState?: (pages: readonly string[] | null) => void;
  readonly children?: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);
  const suppressClick = useRef(0);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { root: root.closest(".scient-pdf-sidebar-content"), rootMargin: "240px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let current = true,
      cancelRender: (() => void) | null = null;
    let loadedPage: Awaited<ReturnType<typeof props.runtime.document.getPage>> | null = null;
    setFailed(false);
    void props.runtime.document
      .getPage(props.pageNumber)
      .then((page) => {
        loadedPage = page;
        if (!current) return;
        const rotation = page.rotate + props.runtime.viewer.pagesRotation;
        const unscaled = page.getViewport({ scale: 1, rotation });
        const width = 132,
          pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({
          scale: (width / unscaled.width) * pixelRatio,
          rotation,
        });
        // Drawn off screen and copied in whole: resizing the shown canvas clears it to black
        // until PDF.js finishes, which flashed every thumbnail after an edit.
        const offscreen = document.createElement("canvas");
        offscreen.width = Math.max(1, Math.floor(viewport.width));
        offscreen.height = Math.max(1, Math.floor(viewport.height));
        const context = offscreen.getContext("2d", { alpha: false });
        if (!context) return;
        const task = page.render({ canvas: offscreen, canvasContext: context, viewport });
        cancelRender = () => task.cancel();
        return task.promise.then(
          () => {
            if (!current) return;
            canvas.width = offscreen.width;
            canvas.height = offscreen.height;
            canvas.style.width = width + "px";
            canvas.style.height = Math.round(viewport.height / pixelRatio) + "px";
            canvas.getContext("2d", { alpha: false })?.drawImage(offscreen, 0, 0);
          },
          (error: unknown) => {
            if (!(error instanceof Error && error.name === "RenderingCancelledException"))
              throw error;
          },
        );
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
    <div
      ref={rootRef}
      className="scient-pdf-thumbnail-item"
      data-drop={dropSide ?? undefined}
      data-checked={props.selected || undefined}
      data-dragged={props.dragged || undefined}
      onContextMenu={(event) => {
        if (props.editable === false) return;
        event.preventDefault();
        event.currentTarget
          .querySelector<HTMLButtonElement>(".scient-reader-page-thumbnail")
          ?.focus({ preventScroll: true });
        props.onContext(
          props.pageNumber,
          { x: event.clientX, y: event.clientY },
          event.currentTarget,
        );
      }}
      onKeyDown={(event) => {
        if (
          props.editable !== false &&
          (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
        ) {
          event.preventDefault();
          const r = event.currentTarget.getBoundingClientRect();
          props.onContext(props.pageNumber, { x: r.left + 20, y: r.top + 20 }, event.currentTarget);
        }
      }}
      onDragOver={(event) => {
        if (props.disabled || !event.dataTransfer.types.includes("application/x-scient-pdf-pages"))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const r = event.currentTarget.getBoundingClientRect();
        setDropSide(event.clientY < r.top + r.height / 2 ? "before" : "after");
      }}
      onDragLeave={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setDropSide(null);
      }}
      onDrop={(event) => {
        setDropSide(null);
        if (
          props.disabled ||
          event.dataTransfer.getData("application/x-scient-pdf-pages") !== props.dragScope
        )
          return;
        event.preventDefault();
        const pages = event.dataTransfer
          .getData("application/x-scient-pdf-page-ids")
          .split(",")
          .filter(Boolean);
        if (!pages.length) return;
        const r = event.currentTarget.getBoundingClientRect();
        props.onMove(props.pageNumber - (event.clientY < r.top + r.height / 2 ? 1 : 0), pages);
      }}
    >
      <ReaderPageThumbnail
        pageNumber={props.pageNumber}
        active={props.active}
        onSelect={(page) => {
          if (performance.now() > suppressClick.current) props.onSelect(page);
        }}
        draggable={props.editable !== false && !props.disabled}
        onDragStart={(event) => {
          if (props.disabled || props.editable === false) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-scient-pdf-pages", props.dragScope);
          event.dataTransfer.setData(
            "application/x-scient-pdf-page-ids",
            props.dragPages.join(","),
          );
          const container = event.currentTarget.closest<HTMLElement>(".scient-pdf-thumbnails");
          const grabbed = canvasRef.current;
          if (grabbed) {
            // The other checked pages that are on screen join the grabbed one.
            const others =
              props.dragPages.length > 1 && container
                ? [
                    ...container.querySelectorAll<HTMLCanvasElement>(
                      ".scient-pdf-thumbnail-item[data-checked] canvas",
                    ),
                  ].filter((canvas) => canvas !== grabbed)
                : [];
            startPdfPageDragFollow({
              transfer: event.dataTransfer,
              canvases: [grabbed, ...others],
              count: props.dragPages.length,
              pointer: { x: event.clientX, y: event.clientY },
            });
          }
          if (container) startDragScroll(container);
          trackPageDrag(props.dragPages, props.onDragState);
        }}
        onDragEnd={() => {
          suppressClick.current = performance.now() + 250;
          setDropSide(null);
          stopDragScroll?.();
        }}
      >
        {failed ? (
          <span className="text-[10px] text-muted-foreground">Preview unavailable</span>
        ) : null}
        <canvas ref={canvasRef} className={failed ? "hidden" : undefined} aria-hidden="true" />
      </ReaderPageThumbnail>
      {props.editable !== false ? (
        <input
          type="checkbox"
          className="scient-pdf-page-checkbox"
          aria-label={`Select page ${props.pageNumber}`}
          checked={props.selected}
          disabled={props.disabled}
          onChange={(event) => {
            event.stopPropagation();
            props.onToggle(
              props.pageNumber,
              "shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey === true,
            );
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {props.children}
    </div>
  );
}
