/* oxlint-disable react/no-array-index-key -- A page keeps its ordinal throughout incremental layout. */
import { observeResize } from "~/lib/observeResize";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useShelfHidden } from "~/scient/documentShelf/ScientDocumentShelf"; // SCIENT-FORK

export type PageSize = {
  readonly width: number;
  readonly height: number;
  readonly background?: string | undefined;
};
export type PaintPage = (
  index: number,
  canvas: HTMLCanvasElement,
  scale: number,
  signal: AbortSignal,
) => Promise<void>;

export function OfficePages(props: {
  pages: readonly PageSize[];
  paint: PaintPage;
  label: string;
  overlay?: (index: number) => ReactNode;
  footer?: (index: number) => ReactNode;
  scrollRef?: RefObject<((index: number, y?: number) => void) | null>;
  onPageChange?: (index: number) => void;
  onError: (error: unknown) => void;
  // SCIENT-FORK:START — a zoom the reader chose replaces fitting each page to the width it is told.
  zoom?: number | undefined;
  onWidth?: ((width: number) => void) | undefined;
  /** The page at the top of the view, and its point there, as scrollRef takes them. */
  onPlace?: ((index: number, y: number) => void) | undefined;
  // SCIENT-FORK:END
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const { scrollRef } = props; // SCIENT-FORK
  const [width, setWidth] = useState(0);
  const [settledWidth, setSettledWidth] = useState(0);
  const [mounted, setMounted] = useState(6);
  // SCIENT-FORK:START — zooming keeps the point at the middle of the view where it was.
  const { zoom } = props;
  const scaleAt = (page: PageSize, at: number) =>
    zoom ?? Math.min(1, Math.max(0, at - 48) / page.width);
  const reportWidth = useEffectEvent((next: number) => props.onWidth?.(next));
  const anchor = useRef<{ index: number; fraction: number } | null>(null);
  const zoomed = useRef(zoom);
  const keepAnchor = () => {
    const root = scroller.current;
    if (!root) return;
    const middle = root.scrollTop + root.clientHeight / 2;
    for (const [index, row] of rows.current)
      if (row.offsetTop <= middle && row.offsetTop + row.offsetHeight >= middle)
        anchor.current = { index, fraction: (middle - row.offsetTop) / row.offsetHeight };
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the container DOM node back to the page point it showed before the zoom resized every page
  useLayoutEffect(() => {
    if (zoomed.current === zoom) return;
    zoomed.current = zoom;
    const root = scroller.current;
    const row = anchor.current && rows.current.get(anchor.current.index);
    if (!root || !row || !anchor.current) return;
    root.scrollTop =
      row.offsetTop + anchor.current.fraction * row.offsetHeight - root.clientHeight / 2;
    root.scrollLeft = (root.scrollWidth - root.clientWidth) / 2;
  }, [zoom]);
  // And reports where the reader is, which a file reopens at.
  const reportPlace = () => {
    const root = scroller.current;
    if (!root || !props.onPlace) return;
    for (const [index, row] of [...rows.current].sort(([a], [b]) => a - b)) {
      const page = props.pages[index];
      if (page && row.offsetTop + row.offsetHeight > root.scrollTop + 24) {
        const y = (root.scrollTop + 24 - row.offsetTop) / scaleAt(page, width);
        props.onPlace(index, Math.max(0, y));
        return;
      }
    }
  };
  // SCIENT-FORK:END
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the scroll container width and debounce raster resizing, releasing the observer and timer on unmount.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout>;
    const unobserve = observeResize(root, ([entry]) => {
      if (!entry) return;
      const next = entry.contentRect.width;
      setWidth(next);
      reportWidth(next); // SCIENT-FORK
      clearTimeout(timer);
      timer = setTimeout(() => setSettledWidth(next), 150);
    });
    return () => {
      clearTimeout(timer);
      unobserve();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Yield between page mounting batches with a timer so large documents do not block the browser.
  useEffect(() => {
    if (mounted >= props.pages.length) return;
    const timer = setTimeout(() => setMounted((n) => Math.min(props.pages.length, n + 50)), 0);
    return () => clearTimeout(timer);
  }, [mounted, props.pages.length]);
  // SCIENT-FORK:START — a page past those mounted so far mounts at once, then is scrolled to.
  const pending = useRef<{ index: number; y: number } | null>(null);
  const stopPending = () => {
    pending.current = null;
  };
  // SCIENT-FORK:END
  useImperativeHandle(
    props.scrollRef,
    () =>
      (index: number, y = 0) => {
        const row = rows.current.get(index);
        const page = props.pages[index];
        // SCIENT-FORK:START
        if ((!row || width === 0) && page) {
          pending.current = { index, y };
          setMounted((count) => Math.max(count, index + 1));
          return;
        }
        pending.current = null;
        // SCIENT-FORK:END
        if (row && page) {
          const root = scroller.current;
          root?.scrollTo({
            top: row.offsetTop + y * scaleAt(page, width) - 24, // SCIENT-FORK
          });
          // SCIENT-FORK:START — a page among the last mounted cannot reach the top of the view
          // yet: scroll again as more mount, unless a newer jump comes or the reader moves first.
          if (
            root &&
            rows.current.size < props.pages.length &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 1
          )
            pending.current = { index, y };
          // SCIENT-FORK:END
        }
      },
    [props.pages, width, zoom], // SCIENT-FORK
  );
  // SCIENT-FORK:START — finish pending jumps after measurement and mounting.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the container DOM node to a page once the page it was asked for has mounted
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target || target.index >= mounted || width === 0) return;
    pending.current = null;
    scrollRef?.current?.(target.index, target.y);
  }, [mounted, width, scrollRef]);
  // SCIENT-FORK:END
  return (
    <div
      ref={scroller}
      className="relative min-h-0 flex-1 overflow-auto bg-muted/60"
      data-office-pages
      // SCIENT-FORK:START — the reader moving cancels a jump still waiting for its pages.
      onPointerDown={stopPending}
      onWheel={stopPending}
      onKeyDown={stopPending}
      // SCIENT-FORK:END
      onScroll={() => {
        keepAnchor(); // SCIENT-FORK
        reportPlace(); // SCIENT-FORK
        const root = scroller.current;
        if (!root || !props.onPageChange) return;
        if (
          root.scrollHeight > root.clientHeight &&
          root.scrollTop + root.clientHeight >= root.scrollHeight - 1
        ) {
          props.onPageChange(Math.min(mounted, props.pages.length) - 1);
          return;
        }
        for (const [index, row] of [...rows.current].sort(([a], [b]) => a - b)) {
          if (row.offsetTop + row.offsetHeight > root.scrollTop + 24) {
            props.onPageChange(index);
            break;
          }
        }
      }}
    >
      {/* SCIENT-FORK: a page wider than the view scrolls sideways instead of losing its left edge.
          The side margins are the 48 px the page widths leave, in pixels: rem follows the text size. */}
      <div
        className="flex w-max min-w-full flex-col items-center gap-4 py-6"
        style={{ paddingInline: 24 }}
      >
        {props.pages.slice(0, mounted).map((page, index) => (
          <OfficePage
            key={index}
            page={page}
            index={index}
            root={scroller}
            register={(el) => {
              if (el) rows.current.set(index, el);
              else rows.current.delete(index);
            }}
            // SCIENT-FORK:START
            scale={scaleAt(page, width)}
            rasterScale={scaleAt(page, settledWidth || width)}
            // SCIENT-FORK:END
            {...props}
          />
        ))}
      </div>
    </div>
  );
}

function OfficePage(props: {
  page: PageSize;
  index: number;
  root: RefObject<HTMLDivElement | null>;
  register: (element: HTMLDivElement | null) => void;
  scale: number;
  rasterScale: number;
  paint: PaintPage;
  label: string;
  overlay?: (index: number) => ReactNode;
  footer?: (index: number) => ReactNode;
  onError: (error: unknown) => void;
}) {
  const {
    root,
    rasterScale,
    index,
    onError,
    page,
    paint,
    scale,
    register,
    label,
    overlay,
    footer,
  } = props;
  const row = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(window.devicePixelRatio || 1);
  // SCIENT-FORK: a view kept hidden (documentShelf) keeps only the pages in view drawn.
  const hidden = useShelfHidden();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the page's viewport proximity to limit painting and text layers to nearby pages.
  useEffect(() => {
    if (!row.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      { root: root.current, rootMargin: hidden ? "0px" : "100% 0px" },
    );
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [root, hidden]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to display density changes so canvas rasters match the current screen.
  useEffect(() => {
    const query = matchMedia(`(resolution: ${ratio}dppx)`);
    const change = () => setRatio(window.devicePixelRatio || 1);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [ratio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the visible page canvas at the current raster scale and cancel obsolete paint requests.
  useEffect(() => {
    const target = canvas.current;
    if (!target || !page || !near || ratio <= 0 || rasterScale <= 0) return;
    const controller = new AbortController();
    // SCIENT-FORK: at most 2^25 device pixels a page, pdf.js's own limit, however far it is zoomed.
    const raster = Math.min(rasterScale, Math.sqrt(2 ** 25 / (page.width * page.height)) / ratio);
    void paint(index, target, raster, controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) onError(cause);
    });
    return () => controller.abort();
  }, [near, index, page, paint, rasterScale, onError, ratio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the canvas backing store when its page moves away from the viewport.
  useEffect(() => {
    const target = canvas.current;
    if (!near && target) {
      target.width = 0;
      target.height = 0;
    }
  }, [near]);
  return (
    <div className="flex shrink-0 flex-col gap-3" style={{ width: page.width * scale }}>
      <div
        ref={(el) => {
          row.current = el;
          register(el);
        }}
        role="group"
        aria-label={`${label} ${index + 1}`}
        className="relative shrink-0 shadow-md"
        style={{
          width: page.width * scale,
          height: page.height * scale,
          background: page.background ?? "#fff",
        }}
      >
        <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 block size-full" />
        {near ? overlay?.(index) : null}
      </div>
      {footer?.(index)}
    </div>
  );
}
