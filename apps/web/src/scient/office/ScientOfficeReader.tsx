/* oxlint-disable react/no-unstable-nested-components -- These callbacks return overlays, and are invoked as render functions. */
import {
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

import { OfficePages, type PageSize, type PaintPage } from "~/components/files/office/OfficePages";
import { attachShortcutHost } from "../keyboard/host";
import { labelKeys } from "../keyboard/keys";
import {
  commandKeys,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../keyboard/preferences";
import { normalizePdfZoom, stepPdfZoom } from "../pdf/pdfReaderModel";
import { DocumentReaderControls } from "../writing/DocumentReaderControls";
import { OfficeFindMarks } from "./OfficeFindMarks";
import { OfficeThumbnails } from "./OfficeThumbnails";
import {
  OfficeFileContext,
  OfficeQuoteActions,
  officeQuoteSource,
  takeOfficeReveal,
  useOfficeReveal,
} from "./officeQuote";
import type { OfficeFindHit } from "./wordFind";

import "../pdf/scientPdfReader.css";

/** What an Office engine gives the reader: its pages, and how to draw and search them. */
export interface OfficeReaderDocument {
  readonly kind: "document" | "presentation";
  readonly pages: readonly PageSize[];
  readonly paint: PaintPage;
  /** Paints a small copy of a page, leaving the pages drawn around the reader's view in place. */
  readonly thumbnail: PaintPage;
  /** The pages that hold `query`, in reading order, with how many times each does. */
  readonly find: (query: string, signal: AbortSignal) => Promise<readonly OfficeFindHit[]>;
}

/** Shows a bitmap a worker painted, unless the paint was withdrawn meanwhile. */
export function showBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap, signal: AbortSignal) {
  const context = canvas.getContext("bitmaprenderer");
  if (!context || signal.aborted) {
    bitmap.close();
    return;
  }
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  context.transferFromImageBitmap(bitmap);
}

type Found = {
  readonly query: string;
  readonly hits: readonly OfficeFindHit[];
  /** The active match, counted from 0 across the document. */
  readonly current: number;
};

/** Where match `current` is: its page and its place among that page's matches. */
function locate(hits: readonly OfficeFindHit[], current: number) {
  let left = current;
  for (const hit of hits) {
    if (left < hit.count) return { index: hit.index, nth: left };
    left -= hit.count;
  }
  return null;
}

/**
 * Word and PowerPoint pages with the PDF reader's controls: page number, zoom, a sidebar of pages
 * and find. The engine's own viewer (T3's) draws the pages; this adds what a reader moves with.
 */
export function ScientOfficeReader(props: {
  readonly document: OfficeReaderDocument;
  readonly scrollRef: RefObject<((index: number, y?: number) => void) | null>;
  readonly overlay?: ((index: number) => ReactNode) | undefined;
  readonly footer?: ((index: number) => ReactNode) | undefined;
  readonly onError: (error: unknown) => void;
}) {
  const { document: office, scrollRef } = props;
  const { find: findIn } = office;
  const pageLabel = office.kind === "presentation" ? "Slide" : "Page";
  const label = office.kind;
  const rootRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(0);
  // "fit" follows the view's width, as the PDF reader's fit width does; unset, a page shows at
  // its own size unless that is wider than the view.
  const [zoom, setZoom] = useState<number | "fit" | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  // A quote opened from the chat: its page, and its text marked there until the reader is used.
  const reveal = useOfficeReveal(use(OfficeFileContext));
  const quoted = reveal && reveal.page <= office.pages.length ? reveal : null;
  const revealed = useRef<typeof reveal>(null);
  const current = office.pages[Math.min(page, office.pages.length - 1)];
  const fit = current && width > 48 ? (width - 48) / current.width : 1;
  const chosen = zoom === "fit" ? normalizePdfZoom(fit) : zoom;
  const scale = chosen ?? Math.min(1, fit);
  const hits = found?.query === query && query.trim() ? found.hits : null;
  const total = hits?.reduce((sum, hit) => sum + hit.count, 0) ?? 0;
  const active = hits && found ? locate(hits, found.current) : null;
  useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcutLabel = (command: string) =>
    commandKeys(command)
      .map((keys) => labelKeys(keys))
      .join(" / ");

  const goTo = (index: number) => {
    const target = Math.max(0, Math.min(office.pages.length - 1, index));
    setPage(target);
    scrollRef.current?.(target);
  };
  const zoomTo = (next: number) => setZoom(normalizePdfZoom(next));
  const fitWidth = () => setZoom("fit");
  const show = (next: Found) => {
    setFound(next);
    const match = locate(next.hits, next.current);
    if (match && match.index !== page) goTo(match.index);
  };
  const step = (backwards: boolean) => {
    if (!found || !hits || total === 0) return;
    show({ ...found, current: (found.current + (backwards ? total - 1 : 1)) % total });
  };
  // A new query starts at the first match on or after the page being read, as the PDF reader does;
  // the same query found again, after Word lays out more pages, keeps its place.
  const showFound = useEffectEvent((searched: string, result: readonly OfficeFindHit[]) => {
    const count = result.reduce((sum, hit) => sum + hit.count, 0);
    if (found?.query === searched) {
      setFound({
        ...found,
        hits: result,
        current: Math.min(found.current, Math.max(0, count - 1)),
      });
      return;
    }
    let first = 0;
    for (const hit of result) {
      if (hit.index >= page) break;
      first += hit.count;
    }
    show({ query: searched, hits: result, current: first < count ? first : 0 });
  });
  const fail = useEffectEvent((error: unknown) => props.onError(error));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the query in the engine's worker, again when its pages change, and cancels the run it replaces
  useEffect(() => {
    if (!query.trim()) return;
    const run = new AbortController();
    void findIn(query, run.signal).then(
      (result) => {
        if (!run.signal.aborted) showFound(query, result);
      },
      (error: unknown) => {
        if (!run.signal.aborted) fail(error);
      },
    );
    return () => run.abort();
  }, [findIn, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the pages' DOM node to a quote the chat asked this file's reader to show, once its page is laid out
  useEffect(() => {
    if (!quoted || revealed.current === quoted) return;
    revealed.current = quoted;
    scrollRef.current?.(quoted.page - 1);
  }, [quoted, scrollRef]);

  const keyboardAction = useRef<(command: string, factor?: number) => boolean>(() => false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps keyboardAction holding the latest shortcut handler
  useLayoutEffect(() => {
    keyboardAction.current = (command, factor = 1) => {
      if (command === "pinch") zoomTo(scale * factor);
      else if (command === "pdf.find") setFocusRequest((request) => request + 1);
      else if (command === "pdf.zoomIn") zoomTo(stepPdfZoom(scale, "in"));
      else if (command === "pdf.zoomOut") zoomTo(stepPdfZoom(scale, "out"));
      else if (command === "pdf.actualSize") zoomTo(1);
      else return false;
      return true;
    };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the reader's root as a shortcut host and its pinch-zoom wheel listener until unmount
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const detach = attachShortcutHost(root, "pdf", {
      execute: (command) => keyboardAction.current(command),
      accepts: (event, command) =>
        command === "pdf.find" ||
        !(event.target instanceof Element && event.target.closest("input,textarea")),
    });
    // A pinch on a trackpad arrives as a wheel with Control held.
    const pinch = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      keyboardAction.current(
        "pinch",
        Math.exp(Math.min(0.5, Math.max(-0.5, -event.deltaY * 0.01))),
      );
    };
    root.addEventListener("wheel", pinch, { passive: false });
    return () => {
      detach();
      root.removeEventListener("wheel", pinch);
    };
  }, []);

  return (
    <div ref={rootRef} className="scient-pdf-reader" aria-label={`${pageLabel}s`}>
      <DocumentReaderControls
        label={label}
        ready={office.pages.length > 0}
        page={page + 1}
        pageCount={office.pages.length}
        sidebarContents={`${pageLabel.toLowerCase()}s`}
        scale={scale}
        sidebarOpen={sidebarOpen}
        searchOpen={query !== ""}
        onPage={(next) => goTo(next - 1)}
        onZoom={zoomTo}
        onActualSize={() => zoomTo(1)}
        onFitWidth={fitWidth}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleSearch={() => setFocusRequest((request) => request + 1)}
        onShowSearch={() => setFocusRequest((request) => request + 1)}
        shortcutLabel={shortcutLabel}
        search={{
          query,
          current: total > 0 && found ? found.current + 1 : 0,
          total,
          notFound: hits !== null && total === 0,
          focusRequest,
          onQuery: setQuery,
          onNavigate: step,
          onClear: () => setQuery(""),
        }}
      />
      <div className="scient-pdf-body">
        {sidebarOpen ? (
          <OfficeThumbnails
            label={pageLabel}
            pages={office.pages}
            paint={office.thumbnail}
            active={page}
            onSelect={goTo}
            onError={props.onError}
          />
        ) : null}
        <div
          ref={setContent}
          className="scient-pdf-content"
          onPointerDown={() => {
            if (quoted) takeOfficeReveal(quoted);
          }}
        >
          <OfficePages
            pages={office.pages}
            paint={office.paint}
            label={pageLabel}
            scrollRef={scrollRef}
            zoom={chosen}
            onWidth={setWidth}
            onPageChange={setPage}
            onError={props.onError}
            overlay={(index) => (
              <div className="absolute inset-0" {...officeQuoteSource(index)}>
                {props.overlay?.(index)}
                {hits?.some((hit) => hit.index === index) ? (
                  <OfficeFindMarks
                    query={query}
                    active={active?.index === index ? active.nth : null}
                  />
                ) : null}
                {quoted?.page === index + 1 ? (
                  <OfficeFindMarks query={quoted.text} active={0} everywhere />
                ) : null}
              </div>
            )}
            {...(props.footer ? { footer: props.footer } : {})}
          />
          <OfficeQuoteActions
            viewport={content}
            unit={office.kind === "presentation" ? "slide" : "page"}
          />
        </div>
      </div>
    </div>
  );
}
