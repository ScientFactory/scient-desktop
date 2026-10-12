import { observeResize } from "~/lib/observeResize";
import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { afterEditorPaint } from "./afterEditorPaint";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { retryMathReadingPreviews, settleMathReadingPreviews } from "./mathReadingNodeView";
import {
  demandLatexViewportPages,
  fallbackLatexViewportPage,
  latexViewportContext,
  latexViewportMeasurement,
  latexViewportPageNodes,
  latexViewportUnit,
  updateLatexOpeningPageReadiness,
} from "./latexViewport";
import { latexPaginationKey } from "./latexVisualPaginationExtension";
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
  let cancel: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!disposed && !cancel)
      cancel = afterEditorPaint(() => {
        cancel = undefined;
        reconcile();
      });
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
      }
      const dimensions = pagination.dimensions;
      const pitch = dimensions.pageHeight + dimensions.pageGap;
      const width = Number.parseFloat(getComputedStyle(view.dom).width);
      const paperBox = paper.getBoundingClientRect();
      const scale = paperBox.width / width;
      if (!(scale > 0) || !Number.isFinite(scale)) return;
      const box = scroll.getBoundingClientRect();
      const first = Math.max(0, Math.floor((box.top - paperBox.top) / scale / pitch));
      const last = Math.min(
        pagination.pageCount - 1,
        Math.floor((box.bottom - paperBox.top) / scale / pitch),
      );
      const wanted = new Set<number>();
      for (let page = first; page <= Math.min(pagination.pageCount - 1, last + 1); page++)
        wanted.add(page + 1);
      const units = latexViewportPageNodes(view, wanted, pagination.pages);
      const nextDemand = new Set(units.map((unit) => unit.node));
      if (nextDemand.size !== demand.size || [...nextDemand].some((node) => !demand.has(node))) {
        demand = nextDemand;
        demandLatexViewportPages(view, demand);
      }
      for (const page of pending.keys()) if (!wanted.has(page + 1)) remove(page);
      let nextDeadline = Infinity;
      let openingReady = true;
      const focused = new Set<number>();
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
          continue;
        }
        if (!record && ready && !unavailable) continue;
        if (!record) {
          const element = globalThis.document.createElement("div");
          element.className = "scient-latex-page-preparation";
          element.dataset.latexPreparingPage = String(number);
          element.setAttribute("role", "status");
          element.setAttribute("aria-live", "polite");
          record = {
            started: performance.now(),
            released: false,
            stable: 0,
            geometry: "",
            waitingForContent: !contentReady,
            awaitingLayout: null,
            element,
          };
          pending.set(page, record);
          layer.append(element);
        }
        record.element.style.top = `${page * pitch}px`;
        record.element.style.height = `${dimensions.pageHeight}px`;
        const expired = performance.now() - record.started >= maximumWaitMs;
        if (!ready && expired && !record.released) {
          record.released = true;
          settleMathReadingPreviews(previews);
          for (const element of assets)
            element.dispatchEvent(new Event("scient-latex-preview-fallback"));
          fallbackLatexViewportPage(view, nodes, true);
          schedule();
        }
        if (ready) {
          const geometry = pageUnits
            .map((unit) => {
              const element = view.nodeDOM(unit.position) as HTMLElement;
              const rect = element.getBoundingClientRect();
              return `${rect.top - paperBox.top}:${rect.height}`;
            })
            .join("|");
          record.stable = geometry === record.geometry ? record.stable + 1 : 1;
          record.geometry = geometry;
          if (record.stable >= 2 && !unavailable) {
            remove(page);
            continue;
          }
          if (record.stable < 2) schedule();
        } else if (!ready) record.stable = 0;
        const released = record.released || (ready && unavailable);
        openingReady &&= released || (ready && record.stable >= 2);
        record.element.dataset.state = released ? "unavailable" : "preparing";
        record.element.setAttribute("aria-busy", String(!released));
        if (released) {
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
          if (record.element.textContent !== "Preparing page…")
            record.element.textContent = "Preparing page…";
          nextDeadline = Math.min(nextDeadline, record.started + maximumWaitMs);
        }
      }
      clearTimeout(deadline);
      updateLatexOpeningPageReadiness(view, openingReady);
      if (Number.isFinite(nextDeadline))
        deadline = setTimeout(schedule, Math.max(0, nextDeadline - performance.now()));
    } finally {
      reconciling = false;
    }
  };
  const stopObserving = observeResize([scroll, paper], schedule);
  const layoutReady = () => {
    layoutSettlement++;
    schedule();
  };
  const dependencies = new MutationObserver(schedule);
  dependencies.observe(view.dom, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-latex-preview-state"],
  });
  scroll.addEventListener("scroll", reconcile, { passive: true });
  view.dom.addEventListener("scient-latex-math-preview", schedule);
  view.dom.addEventListener("load", schedule, true);
  view.dom.addEventListener("error", schedule, true);
  view.dom.addEventListener("focus", reconcile, true);
  view.dom.addEventListener("scient-latex-page-layout-ready", layoutReady);
  schedule();
  return {
    update: schedule,
    destroy() {
      disposed = true;
      cancel?.();
      clearTimeout(deadline);
      stopObserving();
      dependencies.disconnect();
      scroll.removeEventListener("scroll", reconcile);
      view.dom.removeEventListener("scient-latex-math-preview", schedule);
      view.dom.removeEventListener("load", schedule, true);
      view.dom.removeEventListener("error", schedule, true);
      view.dom.removeEventListener("focus", reconcile, true);
      view.dom.removeEventListener("scient-latex-page-layout-ready", layoutReady);
      layer.remove();
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
            update() {
              owner?.update();
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
