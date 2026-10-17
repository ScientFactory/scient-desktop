import { Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { LATEX_VISUAL_LOADING } from "./latexProgressiveLoading";
import { isSourceHistoryAnnotation } from "./visualTyping";
import { observeResize } from "~/lib/observeResize";
import { latexPagedKey, pagedLayoutProgress, pagedPositionAtPoint } from "./latexPagedGeometry";
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

/** The innermost block the reader sees at the top of the reading area. */
const ANCHOR_BLOCK =
  "p, li, h1, h2, h3, h4, h5, h6, .node-latexDisplayMath, .node-latexRichPreview, .node-latexRawBlock, .scient-latex-footnotes";

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
    // distance from the top of the reading area.
    let anchor: {
      position: number | null;
      element: Element;
      offset: number;
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
            let left = paper.left + paper.width / 2;
            let y = box.top + 1;
            // The planner already knows the visible line origins. Page margins
            // and column gutters must not make hit testing reveal dozens of
            // otherwise skipped blocks while searching for the first line.
            const geometry = latexPagedKey.getState(view.state)?.geometry;
            const zoom = paper.width / (view.dom.offsetWidth || 1);
            if (geometry?.length) {
              const top = (y - paper.top) / zoom;
              const bottom = (box.bottom - paper.top) / zoom;
              let first: (typeof geometry)[number] | undefined;
              for (const part of geometry)
                if (part.top >= top && part.top < bottom && (!first || part.top < first.top))
                  first = part;
              if (first) {
                try {
                  const line = view.coordsAtPos(first.from);
                  if (line.bottom > box.top && line.top < box.bottom) {
                    left = (line.left + line.right) / 2;
                    y = Math.max(box.top + 1, (line.top + line.bottom) / 2);
                  }
                } catch {
                  // Replaced atom views retain the ordinary hit-test fallback.
                }
              }
            }
            let hit = view.dom.ownerDocument.elementFromPoint(left, y);
            const usable = (element: Element | null) =>
              element &&
              element !== view.dom &&
              view.dom.contains(element) &&
              (!element.closest('[data-layout="sourceColumns"]') || element.closest(ANCHOR_BLOCK));
            // A page margin or column gutter has no text at the viewport edge.
            // Anchor the first visible content below it rather than dropping the anchor.
            if (!usable(hit)) {
              hit = null;
              search: for (let top = y; top < box.bottom; top += 12) {
                for (const x of [
                  left,
                  paper.left + paper.width / 4,
                  paper.left + (paper.width * 3) / 4,
                ]) {
                  const candidate = view.dom.ownerDocument.elementFromPoint(x, top);
                  if (usable(candidate)) {
                    hit = candidate;
                    left = x;
                    y = top;
                    break search;
                  }
                }
              }
            }
            if (!hit) return;
            // A block the browser has not rendered yet is hit as a whole.
            let block: Element = hit;
            while (block.parentElement !== view.dom) block = block.parentElement!;
            const inner = hit.closest(ANCHOR_BLOCK);
            const element = inner && block.contains(inner) ? inner : block;
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
            anchor = { position, element, offset: 0, scale: scale() };
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
            const delta = top - scroll.getBoundingClientRect().top - anchor.offset;
            if (Math.abs(delta) <= 0.5) return;
            scroll.scrollTop += delta;
            own = scroll.scrollTop;
          };
          let correctionQueued = false;
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
            if (correctionQueued) return;
            correctionQueued = true;
            // All resized blocks share one correction after the observer's
            // delivery, before paint, rather than forcing layout per block.
            queueMicrotask(() => {
              correctionQueued = false;
              if (!disposed) correct();
            });
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
          let idleRequest: number | ReturnType<typeof setTimeout> | null = null;
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
            idleRequest = null;
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
              idleRequest !== null ||
              cancelQuiet ||
              pagedLayoutProgress.has(view)
            )
              return;
            animation = requestAnimationFrame(() => {
              animation = 0;
              if (disposed) return;
              idleRequest =
                typeof requestIdleCallback === "function"
                  ? requestIdleCallback(measure, { timeout: 1000 })
                  : setTimeout(measure, 50);
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
              if (idleRequest !== null) {
                if (typeof cancelIdleCallback === "function" && typeof idleRequest === "number")
                  cancelIdleCallback(idleRequest);
                else clearTimeout(idleRequest);
              }
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
