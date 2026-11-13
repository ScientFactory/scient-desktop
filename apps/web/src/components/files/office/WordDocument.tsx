/* oxlint-disable react/no-array-index-key -- Text spans retain their order within an immutable page. */
/* oxlint-disable react/no-unstable-nested-components -- These callbacks return overlays, and are invoked as render functions. */
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { Fragment, useEffect, useRef, useState } from "react";
import { FileSurfaceLoading } from "../fileSurfaceChrome";
import type { PaintPage } from "./OfficePages";
// SCIENT-FORK:START
import {
  ScientOfficeReader,
  showBitmap,
  type OfficeReaderDocument,
} from "~/scient/office/ScientOfficeReader";
import {
  sessionState,
  slotSession,
  type OfficeSession,
  type OfficeSessionSlot,
} from "~/scient/office/officeSession";
// SCIENT-FORK:END
import { rasterize } from "./vector-pictures";
import { createWorkerClient } from "./worker-rpc";
import {
  layerFont,
  lineHeight,
  type WordMethods,
  type WordPageSize,
  type WordSpan,
  type WordLink,
} from "./word-protocol";

type Opened = {
  pages: readonly WordPageSize[];
  paint: PaintPage;
  engine: ReturnType<typeof createWorkerClient<WordMethods>>;
  // SCIENT-FORK: the reader's sidebar and find, and whether layout has placed every page.
  reader: Pick<OfficeReaderDocument, "thumbnail" | "find">;
  complete: boolean; // SCIENT-FORK
};

// SCIENT-FORK:START — the opened document lives in a session, kept with its file for a reader who
// comes back (scient/office/officeDocuments.ts); the viewer shows whatever state it has reached.
type WordState = { opened?: Opened; limited: boolean; error?: unknown };

function openWordSession(bytes: ArrayBuffer): OfficeSession<WordState> {
  const store = sessionState<WordState>({ limited: false });
  const controller = new AbortController();
  const worker = new Worker(new URL("./document.worker.ts", import.meta.url), { type: "module" });
  const engine = createWorkerClient<WordMethods>(worker);
  const fail = (error: unknown) => {
    if (!controller.signal.aborted) store.set({ ...store.get(), error });
  };
  worker.addEventListener("error", fail);
  worker.addEventListener("messageerror", fail);
  const buffer = bytes.slice(0);
  const paint = async (
    index: number,
    canvas: HTMLCanvasElement,
    scale: number,
    signal: AbortSignal,
    again = false,
  ): Promise<void> => {
    const painted = await engine.call(
      "paint",
      { index, scale, ratio: window.devicePixelRatio || 1 },
      { key: `paint:${index}`, signal },
    );
    void engine
      .call("build", { index: index + 1 }, { key: "build", signal })
      .catch(() => undefined);
    if (!painted) return;
    const context = canvas.getContext("bitmaprenderer");
    if (!context || signal.aborted) {
      painted.bitmap.close();
      return;
    }
    canvas.width = painted.bitmap.width;
    canvas.height = painted.bitmap.height;
    context.transferFromImageBitmap(painted.bitmap);
    if (again || !painted.vectors.length) return;
    const bitmaps = await Promise.all(painted.vectors.map(rasterize));
    if (signal.aborted) {
      bitmaps.forEach((value) => value.bitmap?.close());
      return;
    }
    await engine.call("vectors", bitmaps, {
      transfer: bitmaps.flatMap((value) => (value.bitmap ? [value.bitmap] : [])),
      signal,
    });
    if (!signal.aborted) await paint(index, canvas, scale, signal, true);
  };
  // Thumbnails leave the pages built around the view, and find waits for the
  // whole document's layout, which places every match on its page.
  const laidOut = Promise.withResolvers<void>();
  const reader: Opened["reader"] = {
    thumbnail: async (index, canvas, scale, signal) => {
      const ratio = window.devicePixelRatio || 1;
      const painted = await engine.call(
        "paint",
        { index, scale, ratio, thumbnail: true },
        { key: `thumbnail:${index}`, signal },
      );
      // SVG pictures arrive with the page's own paint; a later thumbnail draws them.
      if (painted) showBitmap(canvas, painted.bitmap, signal);
    },
    find: async (query, signal) => {
      await laidOut.promise;
      const hits = await engine.call("find", { query }, { signal });
      return hits.filter((hit) => hit.index < 1000);
    },
  };
  void engine
    .call("open", { bytes: buffer }, { transfer: [buffer], signal: controller.signal })
    .then(async (first) => {
      if (controller.signal.aborted) return;
      const opened = { pages: first.pages, paint, engine, reader, complete: !first.loading };
      store.set({ ...store.get(), opened });
      if (!first.loading) {
        laidOut.resolve();
        return;
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (!controller.signal.aborted) {
        const step = await engine.call("layout", undefined, { signal: controller.signal });
        if (!step.done) continue;
        // Keep the first 1,000 pages rather than replace them with an error.
        const pages = step.pages.slice(0, 1000);
        store.set({
          opened: { pages, paint, engine, reader, complete: true },
          limited: pages.length < step.pages.length,
        });
        laidOut.resolve();
        break;
      }
    })
    .catch(fail);
  return {
    state: store.get,
    subscribe: store.subscribe,
    failed: () => store.get().error !== undefined,
    // Measured in the desktop app: about 120 MB for the engine, and 1.5 MB per laid-out page.
    memory: () => (120 + 1.5 * (store.get().opened?.pages.length ?? 0)) * 1024 * 1024,
    close: () => {
      controller.abort();
      engine.close();
    },
  };
}

export default function WordDocument(props: {
  bytes: ArrayBuffer;
  onDetails: (text: string) => void;
  onError: (cause: unknown) => void;
  // SCIENT-FORK: the pages past the preview's limit are left out.
  onLimited: () => void;
  // SCIENT-FORK: where the opened document is kept between visits.
  session?: OfficeSessionSlot | undefined;
}) {
  const { onError, bytes, onDetails, onLimited, session: slot } = props;
  const [opened, setOpened] = useState<Opened>();
  const scroll = useRef<((index: number, y?: number) => void) | null>(null);
  // SCIENT-FORK:START
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Shows the document session's state as it lays out, and leaves the session to its slot's owner, or closes it, on unmount.
  useEffect(() => {
    const { session, release } = slotSession(slot, () => openWordSession(bytes));
    const show = (state: WordState) => {
      if (state.error !== undefined) onError(state.error);
      if (state.limited) onLimited();
      setOpened(state.opened);
      if (state.opened) {
        const { pages, complete } = state.opened;
        onDetails(
          `${pages.length}${complete ? "" : "+"} page${pages.length === 1 && complete ? "" : "s"}`,
        );
      }
    };
    show(session.state());
    const unsubscribe = session.subscribe(show);
    return () => {
      unsubscribe();
      release();
    };
  }, [bytes, slot, onDetails, onError, onLimited]);
  // SCIENT-FORK:END
  if (!opened) return <FileSurfaceLoading />;
  const follow = (link: WordLink) => {
    if (link.kind === "external") {
      window.open(link.url, "_blank", "noopener,noreferrer");
      return;
    }
    void opened.engine
      .call("bookmark", { name: link.bookmark })
      .then((target) => {
        if (target) scroll.current?.(target.index, target.y);
      })
      .catch(onError);
  };
  return (
    // SCIENT-FORK:START — Scient's reader draws the pages with its controls, sidebar and find.
    <ScientOfficeReader
      document={{
        kind: "document",
        pages: opened.pages,
        paint: opened.paint,
        complete: opened.complete,
        ...opened.reader,
      }}
      scrollRef={scroll}
      onError={onError}
      // SCIENT-FORK:END
      overlay={(index) => (
        <WordTextLayer
          engine={opened.engine}
          index={index}
          page={opened.pages[index]}
          follow={follow}
        />
      )}
    />
  );
}

function WordTextLayer(props: {
  engine: Opened["engine"];
  index: number;
  page: WordPageSize | undefined;
  follow: (link: WordLink) => void;
}) {
  const { engine, index, page, follow } = props;
  const [spans, setSpans] = useState<readonly WordSpan[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Request selectable text from the document worker and cancel the request when its page leaves the viewport.
  useEffect(() => {
    if (!page) return;
    const controller = new AbortController();
    void engine
      .call("text", { index: index }, { signal: controller.signal })
      .then(setSpans)
      .catch(() => undefined);
    return () => controller.abort();
  }, [engine, index, page]);
  return (
    <div
      className="absolute inset-0 select-text overflow-hidden whitespace-pre text-transparent selection:bg-primary/30 selection:text-transparent"
      style={{ containerType: "inline-size", fontFamily: layerFont, fontSize: 0, lineHeight }}
    >
      {spans.map((span, index) => {
        const text = (
          <span
            dir={span.dir}
            data-office-aside={span.aside} // SCIENT-FORK
            role={span.link ? "link" : undefined}
            tabIndex={span.link ? 0 : undefined}
            aria-label={span.title}
            className="absolute origin-top-left"
            style={{
              left: `${span.left * 100}%`,
              top: `${span.top * 100}%`,
              fontSize: `${span.size * 100}cqw`,
              transform: span.transform,
              cursor: span.link ? "pointer" : "text",
            }}
            onClick={(event) => {
              if (span.link && event.button === 0 && (getSelection()?.isCollapsed ?? true))
                follow(span.link);
            }}
            onKeyDown={(event) => {
              if (span.link && event.key === "Enter") {
                event.preventDefault();
                follow(span.link);
              }
            }}
          >
            {span.text}
          </span>
        );
        return (
          <Fragment key={index}>
            {span.title ? (
              <Tooltip>
                <TooltipTrigger render={text} />
                <TooltipPopup>{span.title}</TooltipPopup>
              </Tooltip>
            ) : (
              text
            )}
            {span.after === "br" ? <br /> : span.after === "tab" ? "\t" : null}
          </Fragment>
        );
      })}
    </div>
  );
}
