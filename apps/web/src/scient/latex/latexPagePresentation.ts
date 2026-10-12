import { observeResize } from "~/lib/observeResize";
import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, NodeSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { afterEditorPaint } from "./afterEditorPaint";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { retryMathReadingPreviews, settleMathReadingPreviews } from "./mathReadingNodeView";
import {
  demandLatexViewportPages,
  fallbackLatexViewportPage,
  latexViewportContext,
  latexViewportMeasurement,
  latexViewportMemberPages,
  latexViewportPageNodes,
  latexViewportPrepared,
  latexViewportUnit,
  updateLatexOpeningPageReadiness,
} from "./latexViewport";
import { latexPaginationKey, latexVisualPageAt } from "./latexVisualPaginationExtension";
import "./latexPagePresentation.css";

type PendingPage = {
  started: number;
  released: boolean;
  stable: number;
  geometry: string;
  waitingForContent: boolean;
  awaitingLayout: number | null;
  element: HTMLDivElement;
};

/** Presentation lives beside the editable document. A mask never splits,
 * reparents or replaces a source paragraph, including one crossing sheets.
 */
function createPagePresentation(view: EditorView, maximumWaitMs: number) {
  const paper = view.dom.closest<HTMLElement>(".scient-latex-visual-paper");
  const scroll = view.dom.closest<HTMLElement>(".scient-latex-visual-scroll");
  if (!paper || !scroll) return { update() {}, destroy() {} };
  const layer = globalThis.document.createElement("div");
  layer.className = "scient-latex-page-preparation-layer";
  paper.dataset.latexPagePresentation = "true";
  paper.append(layer);
  updateLatexOpeningPageReadiness(view, false);
  const pending = new Map<number, PendingPage>();
  let document = view.state.doc;
  let context = "";
  let layoutSettlement = 0;
  let demand = new Set<DocumentNode>();
  let disposed = false;
  let reconciling = false;
  const previousClip = view.dom.style.clipPath;
  const revealed = new Map<number, string>();
  let metrics:
    | {
        width: number;
        pitch: number;
        origin: number;
        scale: number;
        inset: number;
        marginTop: number;
        contentHeight: number;
      }
    | undefined;
  let wantedPages = new Set<number>();
  let paintablePages = new Set<number>();
  let focusedPages = new Set<number>();
  let membership = new WeakMap<Element, Set<number>>();
  const memberPages = (target: EventTarget | null) => {
    let element = target instanceof Element ? target : null;
    while (element && element !== view.dom) {
      const pages = membership.get(element);
      if (pages) return pages;
      const known = latexViewportMemberPages(
        view,
        element,
        latexPaginationKey.getState(view.state)?.pages ?? [],
      );
      if (known !== null)
        return new Set([...known].map((page) => page - 1).filter((page) => wantedPages.has(page)));
      element = element.parentElement;
    }
    return wantedPages;
  };
  let cancel: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const queue = () => {
    if (!disposed && !cancel) {
      const run = () => {
        cancel?.();
        cancel = undefined;
        reconcile();
      };
      const frame = requestAnimationFrame(run);
      // A hidden review window still has to retire stalled preparation.
      const fallback = setTimeout(run, 250);
      cancel = () => {
        cancelAnimationFrame(frame);
        clearTimeout(fallback);
      };
    }
  };
  const schedule = () => {
    queue();
  };
  const clip = () => {
    if (!metrics) return;
    const { width, pitch, origin } = metrics;
    const pagination = latexPaginationKey.getState(view.state)!;
    const path = [...paintablePages]
      .map((page) => {
        const top = page * pitch - origin;
        return `M0 ${top}H${width}V${top + pagination.dimensions.pageHeight}H0Z`;
      })
      .join(" ");
    const value = path ? `path("${path}")` : "inset(100%)";
    if (view.dom.style.clipPath !== value) view.dom.style.clipPath = value;
  };
  const preparing = (element: HTMLElement) => {
    element.dataset.state = "preparing";
    element.setAttribute("aria-busy", "true");
    if (element.querySelector("[data-latex-preparation-spinner]")) return;
    const spinner = globalThis.document.createElement("span");
    spinner.dataset.latexPreparationSpinner = "true";
    spinner.setAttribute("aria-hidden", "true");
    const label = globalThis.document.createElement("span");
    label.textContent = "Preparing page…";
    element.replaceChildren(spinner, label);
  };
  const cover = (page: number, contentPending = false, mounting = false) => {
    let record = pending.get(page);
    if (!record) {
      const element = globalThis.document.createElement("div");
      element.className = "scient-latex-page-preparation";
      element.dataset.latexPreparingPage = String(page + 1);
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      record = {
        started: performance.now(),
        released: false,
        stable: 0,
        geometry: "",
        waitingForContent: contentPending,
        awaitingLayout: null,
        element,
      };
      pending.set(page, record);
      layer.append(element);
    }
    record.waitingForContent ||= contentPending;
    if (metrics) {
      record.element.style.top = `${page * metrics.pitch + metrics.marginTop}px`;
      record.element.style.height = `${metrics.contentHeight}px`;
    }
    if (!record.released) {
      if (mounting) {
        record.element.dataset.state = "mounting";
        record.element.replaceChildren();
      } else preparing(record.element);
    }
    return record;
  };
  // A synchronous fence uses the previous frame's page geometry. It never
  // searches the document or dispatches editor transactions.
  const fence = (pages: Iterable<number>, contentPending = false) => {
    const active = view.dom.ownerDocument.activeElement;
    const object = active instanceof Element && active !== view.dom && view.dom.contains(active);
    const activePages = new Set(object ? memberPages(active) : []);

    const selection = view.state.selection;
    const enteringMath =
      selection instanceof NodeSelection &&
      (selection.node.type.name === "latexInlineMath" ||
        selection.node.type.name === "latexDisplayMath");
    if (view.hasFocus() || view.composing || enteringMath) {
      for (const position of [view.state.selection.anchor, view.state.selection.head]) {
        const page = latexVisualPageAt(view.state, position);
        if (page !== null) activePages.add(page - 1);
      }
      for (const page of focusedPages) activePages.add(page);
    }
    for (const page of activePages) {
      pending.get(page)?.element.remove();
      pending.delete(page);
      paintablePages.add(page);
    }
    for (const page of pages) {
      if (activePages.has(page)) continue;
      const pagination = latexPaginationKey.getState(view.state)!;
      const cached =
        !contentPending &&
        latexViewportPageNodes(view, new Set([page + 1]), pagination.pages).every((unit) =>
          latexViewportPrepared(view, unit.node, unit.position),
        );
      cover(page, contentPending, cached);
      paintablePages.delete(page);
    }
    clip();
  };
  const dependencyTarget = (target: EventTarget | null) => {
    if (metrics && target instanceof Element) {
      const preview = target.matches(".scient-latex-math-preview")
        ? target
        : target.querySelector(".scient-latex-math-preview");
      const pending =
        (preview !== null && !mathReadingPreviewReady(preview)) ||
        target.getAttribute("data-latex-preview-state") === "pending";
      if (pending) fence(memberPages(target), true);
    }
    schedule();
  };
  const dependencyChanged = (event: Event) => {
    if (event instanceof CustomEvent && event.detail?.cached) schedule();
    else dependencyTarget(event.target);
  };
  const focusChanged = () => {
    fence([]);
    schedule();
  };
  const remove = (page: number) => {
    pending.get(page)?.element.remove();
    pending.delete(page);
  };
  const reconcile = () => {
    if (disposed || reconciling || view.isDestroyed || !scroll.clientHeight) return;
    reconciling = true;
    try {
      const pagination = latexPaginationKey.getState(view.state);
      if (!pagination?.pageCount) return;
      const nextContext = latexViewportContext(view, view.state.doc, 0);
      if (document !== view.state.doc || context !== nextContext) {
        for (const page of pending.keys()) remove(page);
        document = view.state.doc;
        context = nextContext;
        revealed.clear();
      }
      const dimensions = pagination.dimensions;
      const pitch = dimensions.pageHeight + dimensions.pageGap;
      const width = Number.parseFloat(getComputedStyle(view.dom).width);
      const paperBox = paper.getBoundingClientRect();
      const scale = paperBox.width / width;
      if (!(scale > 0) || !Number.isFinite(scale)) return;
      const box = scroll.getBoundingClientRect();
      metrics = {
        width,
        pitch,
        origin: (view.dom.getBoundingClientRect().top - paperBox.top) / scale,
        scale,
        inset: paperBox.top - box.top + scroll.scrollTop,
        marginTop: dimensions.marginTop,
        contentHeight: dimensions.pageHeight - dimensions.marginTop - dimensions.marginBottom,
      };
      const first = Math.max(0, Math.floor((box.top - paperBox.top) / scale / pitch));
      const last = Math.min(
        pagination.pageCount - 1,
        Math.floor((box.bottom - paperBox.top) / scale / pitch),
      );
      const wanted = new Set<number>();
      for (let page = first; page <= Math.min(pagination.pageCount - 1, last + 1); page++)
        wanted.add(page + 1);
      wantedPages = new Set([...wanted].map((page) => page - 1));
      const units = latexViewportPageNodes(view, wanted, pagination.pages);
      const nextDemand = new Set(units.map((unit) => unit.node));
      const demandChanged =
        nextDemand.size !== demand.size || [...nextDemand].some((node) => !demand.has(node));
      for (const page of pending.keys()) if (!wanted.has(page + 1)) remove(page);
      const compatible = new Set<number>();
      for (const number of wanted) {
        const ready = latexViewportPageNodes(view, new Set([number]), pagination.pages).every(
          (unit) => latexViewportPrepared(view, unit.node, unit.position),
        );
        if (ready) compatible.add(number - 1);
        if (!ready || !paintablePages.has(number - 1)) cover(number - 1, false, ready);
      }
      if (demandChanged) {
        demand = nextDemand;
        demandLatexViewportPages(view, demand);
      }
      const paintable = new Set<number>();
      let nextDeadline = Infinity;
      let openingReady = true;
      const focused = new Set<number>();
      const nextMembership = new WeakMap<Element, Set<number>>();
      const active = view.dom.ownerDocument.activeElement;
      const activeObject =
        active instanceof HTMLElement && view.dom.contains(active) && active !== view.dom;
      if (view.hasFocus() || view.composing || activeObject) {
        for (const position of [view.state.selection.anchor, view.state.selection.head]) {
          try {
            const point = view.coordsAtPos(position);
            focused.add(Math.floor((point.top - paperBox.top) / scale / pitch));
          } catch {
            /* An opaque endpoint will be admitted by the viewport owner. */
          }
        }
      }
      for (const element of [
        ...(activeObject ? [active] : []),
        ...view.dom.querySelectorAll("math-field"),
      ])
        focused.add(
          Math.floor((element.getBoundingClientRect().top - paperBox.top) / scale / pitch),
        );
      for (const number of wanted) {
        const page = number - 1;
        const pageTop = paperBox.top + page * pitch * scale;
        const pageBottom = pageTop + dimensions.pageHeight * scale;
        const pageUnits = latexViewportPageNodes(view, new Set([number]), pagination.pages);
        const nodes = new Set(pageUnits.map((unit) => unit.node));
        const elements = [
          ...pageUnits
            .map((unit) => view.nodeDOM(unit.position))
            .filter((element): element is HTMLElement => element instanceof HTMLElement),
          ...[
            ...view.dom.querySelectorAll(
              "img, .scient-latex-math-preview, [data-latex-preview-state]",
            ),
          ].filter((element) => !element.closest("[data-latex-viewport]")),
        ];
        const blocks = elements.filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > pageTop && rect.top < pageBottom;
        });
        for (const element of blocks) {
          const pages = nextMembership.get(element) ?? new Set<number>();
          pages.add(page);
          nextMembership.set(element, pages);
        }
        const previews = blocks.flatMap((element) =>
          element.matches(".scient-latex-math-preview")
            ? [element]
            : [...element.querySelectorAll(".scient-latex-math-preview")],
        );
        const images = blocks.flatMap((element) =>
          element instanceof HTMLImageElement ? [element] : [...element.querySelectorAll("img")],
        );
        const assets = blocks.filter((element) => element.hasAttribute("data-latex-preview-state"));
        const geometryReady = pageUnits.every((unit) => {
          const dom = view.nodeDOM(unit.position);
          return (
            dom instanceof HTMLElement &&
            !dom.hasAttribute("data-latex-viewport-closed") &&
            (!latexViewportUnit(view, unit.node, unit.position) ||
              !!latexViewportMeasurement(view, unit.node, unit.position))
          );
        });
        const contentReady =
          previews.every(mathReadingPreviewReady) &&
          images.every((image) => image.complete) &&
          assets.every((element) => element.getAttribute("data-latex-preview-state") !== "pending");
        const unavailable =
          previews.some((element) => element.hasAttribute("data-math-preview-fallback")) ||
          images.some((image) => image.complete && image.naturalWidth === 0) ||
          assets.some(
            (element) => element.getAttribute("data-latex-preview-state") === "unavailable",
          );
        let record = pending.get(page);
        if (record?.waitingForContent && contentReady) {
          record.awaitingLayout = layoutSettlement;
          view.dom.dispatchEvent(
            new CustomEvent("scient-latex-viewport-measure", { bubbles: true, detail: blocks }),
          );
        }
        if (record) record.waitingForContent = !contentReady;
        const ready =
          geometryReady &&
          contentReady &&
          (record?.awaitingLayout == null || layoutSettlement > record.awaitingLayout);
        // Current typing/caret ownership is stronger than passive presentation.
        if (focused.has(page)) {
          remove(page);
          paintable.add(page);
          continue;
        }
        const geometry = pageUnits
          .map((unit) => {
            const element = view.nodeDOM(unit.position);
            if (!(element instanceof HTMLElement)) return "missing";
            const rect = element.getBoundingClientRect();
            return `${unit.position}:${rect.top - paperBox.top}:${rect.height}`;
          })
          .join("|");
        if (
          ready &&
          !unavailable &&
          (record == null || (!record.waitingForContent && record.awaitingLayout == null)) &&
          (compatible.has(page) || revealed.get(page) === geometry)
        ) {
          remove(page);
          paintable.add(page);
          continue;
        }
        if (!record) {
          record = cover(page, !contentReady);
        }
        record.element.style.top = `${page * pitch + dimensions.marginTop}px`;
        record.element.style.height = `${metrics.contentHeight}px`;
        const expired = performance.now() - record.started >= maximumWaitMs;
        if (expired && !record.released && (!ready || record.stable < 2)) {
          record.released = true;
          settleMathReadingPreviews(previews);
          for (const element of assets)
            element.dispatchEvent(new Event("scient-latex-preview-fallback"));
          fallbackLatexViewportPage(view, nodes, true);
          queue();
        }
        if (ready) {
          record.stable = geometry === record.geometry ? record.stable + 1 : 1;
          record.geometry = geometry;
          if (record.stable >= 2 && !unavailable) {
            revealed.set(page, geometry);
            paintable.add(page);
            remove(page);
            continue;
          }
          if (record.stable < 2) queue();
        } else if (!ready) record.stable = 0;
        const released = record.released || (ready && unavailable);
        if (number <= last + 1) openingReady &&= released || (ready && record.stable >= 2);
        record.element.dataset.state = released ? "unavailable" : "preparing";
        record.element.setAttribute("aria-busy", String(!released));
        if (released) {
          paintable.add(page);
          if (!record.element.querySelector("button")) {
            record.element.replaceChildren();
            const label = globalThis.document.createElement("span");
            label.textContent = "Some content could not finish preparing.";
            const retry = globalThis.document.createElement("button");
            retry.type = "button";
            retry.textContent = "Retry page";
            retry.addEventListener("click", () => {
              record!.released = false;
              record!.started = performance.now();
              record!.stable = 0;
              record!.awaitingLayout = layoutSettlement;
              fallbackLatexViewportPage(view, nodes, false);
              retryMathReadingPreviews(previews);
              for (const element of assets)
                element.dispatchEvent(new Event("scient-latex-preview-retry"));
              view.dom.dispatchEvent(
                new CustomEvent("scient-latex-viewport-measure", { bubbles: true, detail: blocks }),
              );
              schedule();
            });
            record.element.append(label, retry);
          }
        } else {
          preparing(record.element);
          nextDeadline = Math.min(nextDeadline, record.started + maximumWaitMs);
        }
      }
      // Clipping affects paint only. Source DOM, native selection and measured
      // rectangles stay intact, while newly scrolled sheets and gaps cannot
      // expose ink before their page has passed the readiness fence.
      for (const page of focused) paintable.add(page);
      paintablePages = paintable;
      focusedPages = focused;
      membership = nextMembership;
      clip();
      clearTimeout(deadline);
      updateLatexOpeningPageReadiness(view, openingReady);
      if (Number.isFinite(nextDeadline)) {
        const remaining = nextDeadline - performance.now();
        if (remaining > 0) deadline = setTimeout(schedule, remaining);
        else queue();
      }
    } finally {
      reconciling = false;
    }
  };
  const stopObserving = observeResize([scroll, paper], () => {
    fence(wantedPages);
    schedule();
  });
  const layoutReady = () => {
    layoutSettlement++;
    schedule();
  };
  const scrolled = () => {
    if (metrics) {
      const pagination = latexPaginationKey.getState(view.state)!;
      const first = Math.max(
        0,
        Math.floor((scroll.scrollTop - metrics.inset) / metrics.scale / metrics.pitch),
      );
      const last = Math.min(
        pagination.pageCount - 1,
        Math.floor(
          (scroll.scrollTop - metrics.inset + scroll.clientHeight) / metrics.scale / metrics.pitch,
        ) + 1,
      );
      const incoming = [];
      for (let page = first; page <= last; page++)
        if (!paintablePages.has(page)) incoming.push(page);
      fence(incoming);
    }
    schedule();
  };
  const dependencies = new MutationObserver((records) => {
    for (const target of new Set(records.map((record) => record.target))) dependencyTarget(target);
  });
  dependencies.observe(view.dom, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-latex-preview-state"],
  });
  scroll.addEventListener("scroll", scrolled, { passive: true });
  view.dom.addEventListener("scient-latex-math-preview", dependencyChanged);
  view.dom.addEventListener("load", dependencyChanged, true);
  view.dom.addEventListener("error", dependencyChanged, true);
  view.dom.addEventListener("focus", focusChanged, true);
  view.dom.addEventListener("scient-latex-page-layout-ready", layoutReady);
  schedule();
  return {
    update(previous: EditorState) {
      const before = latexPaginationKey.getState(previous);
      const after = latexPaginationKey.getState(view.state);
      if (
        previous.doc !== view.state.doc ||
        before?.pages !== after?.pages ||
        before?.dimensions !== after?.dimensions
      )
        fence(wantedPages);
      schedule();
    },
    destroy() {
      disposed = true;
      cancel?.();
      clearTimeout(deadline);
      stopObserving();
      dependencies.disconnect();
      scroll.removeEventListener("scroll", scrolled);
      view.dom.removeEventListener("scient-latex-math-preview", dependencyChanged);
      view.dom.removeEventListener("load", dependencyChanged, true);
      view.dom.removeEventListener("error", dependencyChanged, true);
      view.dom.removeEventListener("focus", focusChanged, true);
      view.dom.removeEventListener("scient-latex-page-layout-ready", layoutReady);
      layer.remove();
      view.dom.style.clipPath = previousClip;
      delete paper.dataset.latexPagePresentation;
    },
  };
}

export const LatexPagePresentation = Extension.create<{ maximumWaitMs: number }>({
  name: "latexPagePresentation",
  addOptions: () => ({ maximumWaitMs: 5000 }),
  addProseMirrorPlugins() {
    const { maximumWaitMs } = this.options;
    return [
      new Plugin({
        view(view) {
          let owner: ReturnType<typeof createPagePresentation> | undefined;
          let disposed = false;
          let cancel: (() => void) | undefined;
          const attach = () => {
            cancel = undefined;
            if (disposed) return;
            if (view.dom.closest(".scient-latex-visual-paper"))
              owner = createPagePresentation(view, maximumWaitMs);
            else cancel = afterEditorPaint(attach);
          };
          cancel = afterEditorPaint(attach);
          return {
            update(_view, previous) {
              owner?.update(previous);
            },
            destroy() {
              disposed = true;
              cancel?.();
              owner?.destroy();
            },
          };
        },
      }),
    ];
  },
});
