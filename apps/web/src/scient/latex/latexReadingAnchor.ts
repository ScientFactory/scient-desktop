import { Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { LATEX_VISUAL_LOADING } from "./latexProgressiveLoading";
import { isSourceHistoryAnnotation } from "./visualTyping";
import { observeResize } from "~/lib/observeResize";
import {
  pagedLayoutProgress,
  pagedPositionAtPoint,
  readLatexVisibleReadingTarget,
} from "./latexPagedGeometry";
import { afterLatexInputQuiet, latexInputQuietDelay } from "./latexInputPriority";

/** Whether a transaction may add, remove or replace top-level blocks. */
function changesTopLevel(transaction: Transaction): boolean {
  if (transaction.before.childCount !== transaction.doc.childCount) return true;
  return transaction.steps.some((step, index) => {
    if (isSourceHistoryAnnotation(step)) return false;
    const { from, to } = step as { from?: number; to?: number };
    const doc = transaction.docs[index]!;
    return (
      (from !== undefined && doc.resolve(from).depth === 0) ||
      (to !== undefined && doc.resolve(to).depth === 0)
    );
  });
}

/** Blocks rendered per frame to learn their real heights. */
const MEASURE_CHUNK = 48;

/**
 * Keeps the line at the top of the reading area still. Content may change
 * size anywhere (a formula or image finishing, fonts, an edit, blocks added
 * while the document loads); the reading position moves only when the reader
 * scrolls or the caret must be brought into view. The browser's own anchoring
 * is off: it anchors on the caret while editing, so Enter scrolled the page.
 */
export const LatexReadingAnchor = Extension.create<{ readonly syncLayout: () => void }>({
  name: "latexReadingAnchor",
  addOptions() {
    return { syncLayout: () => {} };
  },
  addProseMirrorPlugins() {
    const { syncLayout } = this.options;
    // Set before a document change is applied: the scroll offset then, or
    // "append" for loading below the reading area, which cannot move it.
    let pending: number | "append" | null = null;
    // A transaction added, removed or replaced top-level blocks.
    let structural = false;
    let affectsAnchor = false;
    let scroller: () => HTMLElement | null = () => null;
    // The text at the top of the reading area: its document position (mapped
    // through edits) and, when it has none, its block. `offset` is its
    // distance from the top of the reading area, scrolled to `scrollTop`.
    let anchor: {
      position: number | null;
      element: Element;
      offset: number;
      scrollTop: number;
      scale: number;
    } | null = null;
    return [
      new Plugin({
        appendTransaction(transactions) {
          for (const transaction of transactions) {
            if (!transaction.docChanged) continue;
            structural ||= changesTopLevel(transaction);
            if (!anchor || anchor.position === null) continue;
            let position = anchor.position;
            for (const map of transaction.mapping.maps) {
              map.forEach((from) => {
                if (from <= position) affectsAnchor = true;
              });
              position = map.map(position);
            }
            const mapped = transaction.mapping.mapResult(anchor.position);
            anchor.position = mapped.deleted ? null : mapped.pos;
          }
          return null;
        },
        filterTransaction(transaction) {
          if (!transaction.docChanged) return true;
          const appending =
            transaction.getMeta(LATEX_VISUAL_LOADING) !== undefined &&
            !transaction.steps.some((step) => (step as { from?: number }).from === 0);
          pending = appending ? "append" : (scroller()?.scrollTop ?? null);
          return true;
        },
        view(view) {
          scroller = () => view.dom.closest<HTMLElement>(".scient-latex-visual-scroll");
          let own: number | null = null;
          let frame = 0;
          const scale = () => {
            const width = view.dom.offsetWidth;
            return width ? view.dom.getBoundingClientRect().width / width : 1;
          };
          const capture = () => {
            frame = 0;
            const scroll = scroller();
            anchor = null;
            if (!scroll || !view.dom.isConnected) return;
            const box = scroll.getBoundingClientRect();
            const paper = view.dom.getBoundingClientRect();
            if (paper.top >= box.top) return; // nothing above can move the reading position
            const target = readLatexVisibleReadingTarget(view, box, paper);
            if (!target) return;
            const { element, left, top: y } = target;
            // The line itself: within a long paragraph, content above it can
            // grow while the paragraph's top stays put.
            let position: number | null = null;
            if (
              !element.matches(
                ".node-latexDisplayMath,.node-latexRichPreview,.node-latexRawBlock,.scient-latex-footnotes",
              )
            )
              try {
                position = pagedPositionAtPoint(view, left, y);
                if (position !== null) {
                  const line = view.coordsAtPos(position);
                  const tolerance = Math.max(4, (line.bottom - line.top) / 2);
                  // A page margin/gap can hit-test to distant text; that text is not the reading line.
                  if (y < line.top - tolerance || y > line.bottom + tolerance) position = null;
                }
              } catch {
                position = null;
              }
            anchor = { position, element, offset: 0, scrollTop: scroll.scrollTop, scale: scale() };
            const top = anchorTop();
            if (top === null) anchor = null;
            else anchor.offset = top - box.top;
          };
          /** Where the anchored line is now, in viewport coordinates. */
          const anchorTop = () => {
            if (!anchor) return null;
            if (anchor.position !== null && anchor.position <= view.state.doc.content.size)
              try {
                return view.coordsAtPos(anchor.position).top;
              } catch {
                // Fall back to the block.
              }
            return anchor.element.isConnected ? anchor.element.getBoundingClientRect().top : null;
          };
          const correct = () => {
            const scroll = scroller();
            if (!scroll || !anchor) return;
            if (Math.abs(scale() - anchor.scale) > 0.001) {
              capture();
              return;
            }
            syncLayout();
            const top = anchorTop();
            if (top === null) {
              capture();
              return;
            }
            const box = scroll.getBoundingClientRect();
            // Scrolled since the anchor was taken, possibly before the scroll
            // event (a restored reading position, the caret followed): the
            // reading line is a new one, taken now. Content that moved the old
            // line lies above the new one too only when reading moved down; a
            // range clamped by content shrinking above is not a reading move.
            const scrolled = scroll.scrollTop - anchor.scrollTop;
            if (Math.abs(scrolled) > 0.5) {
              const drift = top - box.top - (anchor.offset - scrolled);
              if (scrolled > 0 && Math.abs(drift) > 0.5) {
                scroll.scrollTop += drift;
                own = scroll.scrollTop;
              }
              capture();
              return;
            }
            const delta = top - box.top - anchor.offset;
            if (Math.abs(delta) <= 0.5) return;
            scroll.scrollTop += delta;
            anchor.scrollTop = scroll.scrollTop;
            own = scroll.scrollTop;
          };
          let correctionQueued = false;
          // One correction after the current task's changes, before any later
          // task or rendering update can see the reading line moved.
          const queueCorrection = () => {
            if (!anchor || correctionQueued) return;
            correctionQueued = true;
            queueMicrotask(() => {
              correctionQueued = false;
              if (!disposed) correct();
            });
          };
          const resized = (entries: readonly ResizeObserverEntry[]) => {
            if (!anchor) return;
            if (
              anchor.element.isConnected &&
              entries.every(
                ({ target }) =>
                  !target.contains(anchor!.element) &&
                  !!(
                    target.compareDocumentPosition(anchor!.element) &
                    Node.DOCUMENT_POSITION_PRECEDING
                  ),
              )
            )
              return; // Growing content below the reading line cannot move it.
            // All resized blocks share one correction after the observer's
            // delivery, before paint, rather than forcing layout per block.
            queueCorrection();
          };
          const scrolled = () => {
            const scroll = scroller();
            if (own !== null && scroll && Math.abs(scroll.scrollTop - own) < 1) {
              own = null;
              return;
            }
            own = null;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(capture);
          };
          // Any block changing size after layout, before it is painted.
          const observed = new Map<Element, () => void>();
          // Blocks off screen are not rendered (content-visibility) and stand
          // in at an estimated height until they are. Render each block once,
          // a chunk per frame while idle, so the browser remembers its real
          // height: jumps and the scrollbar then land exactly, and content
          // never changes size under the reader later.
          const unmeasured = new Set<Element>();
          let marked: Element[] = [];
          let animation = 0;
          let cancelMeasure: (() => void) | undefined;
          let disposed = false;
          let cancelQuiet: (() => void) | undefined;
          /** Follows the top-level blocks; only structural changes alter them. */
          const sync = () => {
            for (const [element, stop] of observed)
              if (element.parentElement !== view.dom) {
                stop();
                observed.delete(element);
                unmeasured.delete(element);
              }
            for (const element of view.dom.children)
              if (!observed.has(element)) {
                observed.set(element, observeResize(element, resized));
                unmeasured.add(element);
              }
          };
          let observedScroll: HTMLElement | null = null;
          const attach = () => {
            const scroll = scroller();
            if (scroll === observedScroll) return;
            observedScroll?.removeEventListener("scroll", scrolled);
            observedScroll = scroll;
            scroll?.addEventListener("scroll", scrolled, { passive: true });
          };
          // ProseMirror redraws a block whose attributes change under it; this
          // marker is ours, so its observer is paused while it is written.
          const observer = (view as EditorView & { domObserver: { stop(): void; start(): void } })
            .domObserver;
          const unobserved = (change: () => void) => {
            observer.stop();
            try {
              change();
            } finally {
              observer.start();
            }
          };
          const unmark = () => {
            const done = marked;
            marked = [];
            if (done.length)
              unobserved(() => {
                for (const element of done) element.removeAttribute("data-latex-measure");
              });
          };
          const measure = () => {
            cancelMeasure = undefined;
            if (disposed) return;
            unmark();
            // The page planner measures natural copies and supplies intrinsic heights.
            // Revealing every live block as well repeats that work and invalidates layout.
            if (pagedLayoutProgress.has(view)) return;
            if (latexInputQuietDelay(view.dom) > 0) {
              cancelQuiet = afterLatexInputQuiet(() => {
                cancelQuiet = undefined;
                scheduleMeasure();
              }, view.dom);
              return;
            }
            if (view.dom.hasAttribute("data-latex-loading")) {
              scheduleMeasure();
              return;
            }
            for (const element of unmeasured) {
              unmeasured.delete(element);
              if (element.parentElement !== view.dom) continue;
              marked.push(element);
              if (marked.length >= MEASURE_CHUNK) break;
            }
            if (marked.length === 0) return;
            unobserved(() => {
              for (const element of marked) element.setAttribute("data-latex-measure", "");
            });
            // Lay the chunk out now, inside the idle period; it stays rendered
            // through the next frame, which records its size.
            void (marked.at(-1) as HTMLElement).offsetHeight;
            scheduleMeasure();
          };
          const scheduleMeasure = () => {
            if (
              disposed ||
              animation ||
              cancelMeasure ||
              cancelQuiet ||
              pagedLayoutProgress.has(view)
            )
              return;
            animation = requestAnimationFrame(() => {
              animation = 0;
              if (disposed) return;
              // A later native/fake API replacement must not change this request's owner.
              if (typeof window.requestIdleCallback === "function") {
                const cancel = window.cancelIdleCallback.bind(window);
                const request = window.requestIdleCallback(measure, { timeout: 1000 });
                cancelMeasure = () => cancel(request);
              } else {
                const cancel = window.clearTimeout.bind(window);
                const request = window.setTimeout(measure, 50);
                cancelMeasure = () => cancel(request);
              }
            });
          };
          // A formula or image finishing while its block is not rendered
          // changes the block's real height: measure that block again.
          const contentChanged = (event: Event) => {
            let block = event.target as Node | null;
            while (block && block.parentNode !== view.dom) block = block.parentNode;
            if (block instanceof Element && observed.has(block)) {
              unmeasured.add(block);
              scheduleMeasure();
            }
            // A formula's rendering lands in its shadow root inside a preview task;
            // resize delivery follows only at the next rendering update. Correct now,
            // so no later task or paint sees the reading line moved.
            const pending =
              event.type === "scient-latex-math-preview" &&
              (event as CustomEvent<{ pending?: boolean }>).detail?.pending;
            if (!pending) queueCorrection();
          };
          view.dom.addEventListener("scient-latex-math-preview", contentChanged);
          view.dom.addEventListener("load", contentChanged, true);
          view.dom.addEventListener("scient-latex-layout", correct);
          attach();
          sync();
          scheduleMeasure();
          return {
            update(_view, previous) {
              attach();
              // Typing inside a block keeps the same top-level elements.
              if (structural || view.dom.children.length !== observed.size) {
                structural = false;
                sync();
                if (unmeasured.size) scheduleMeasure();
              }
              if (view.state.doc === previous.doc) return;
              const before = pending;
              pending = null;
              const changedAbove = affectsAnchor;
              affectsAnchor = false;
              if (before === "append") return;
              const scroll = scroller();
              // ProseMirror scrolled the caret into view: that is the new position.
              if (scroll && before !== null && scroll.scrollTop !== before) capture();
              // A mapped reading line is unaffected by prose edited below it.
              // Wrapping, page glue and asynchronous sizes are corrected by
              // layout/resize delivery, without a forced layout in this input.
              else if (changedAbove || anchor?.position === null) correct();
            },
            destroy() {
              disposed = true;
              cancelQuiet?.();
              cancelAnimationFrame(animation);
              cancelMeasure?.();
              cancelMeasure = undefined;
              // The view is going away: its observer is not restarted.
              for (const element of marked) element.removeAttribute("data-latex-measure");
              marked = [];
              view.dom.removeEventListener("scient-latex-math-preview", contentChanged);
              view.dom.removeEventListener("load", contentChanged, true);
              view.dom.removeEventListener("scient-latex-layout", correct);
              cancelAnimationFrame(frame);
              for (const stop of observed.values()) stop();
              observed.clear();
              observedScroll?.removeEventListener("scroll", scrolled);
            },
          };
        },
      }),
    ];
  },
});
