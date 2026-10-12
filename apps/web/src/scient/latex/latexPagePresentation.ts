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
  const previousClip = view.dom.style.clipPath;
  const revealed = new Map<number, string>();
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
    // Cover invalidated content in this task, including ProseMirror updates.
    // Admission and measurement run in the next pre-paint frame, never here.
    reconcile(false);
    queue();
  };
  const remove = (page: number) => {
    pending.get(page)?.element.remove();
    pending.delete(page);
  };
  const reconcile = (advance = true) => {
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
      const demandChanged =
        nextDemand.size !== demand.size || [...nextDemand].some((node) => !demand.has(node));
      for (const page of pending.keys()) if (!wanted.has(page + 1)) remove(page);
      const paintable = new Set<number>();
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
        if (advance && record?.waitingForContent && contentReady) {
          record.awaitingLayout = layoutSettlement;
          view.dom.dispatchEvent(
            new CustomEvent("scient-latex-viewport-measure", { bubbles: true, detail: blocks }),
          );
        }
        if (advance && record) record.waitingForContent = !contentReady;
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
          revealed.get(page) === geometry
        ) {
          remove(page);
          paintable.add(page);
          continue;
        }
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
        if (advance && expired && !record.released && (!ready || record.stable < 2)) {
          record.released = true;
          settleMathReadingPreviews(previews);
          for (const element of assets)
            element.dispatchEvent(new Event("scient-latex-preview-fallback"));
          fallbackLatexViewportPage(view, nodes, true);
          queue();
        }
        if (ready) {
          if (advance) {
            record.stable = geometry === record.geometry ? record.stable + 1 : 1;
            record.geometry = geometry;
          }
          if (record.stable >= 2 && !unavailable) {
            revealed.set(page, geometry);
            paintable.add(page);
            remove(page);
            continue;
          }
          if (record.stable < 2) queue();
        } else if (!ready) record.stable = 0;
        const released = record.released || (ready && unavailable);
        openingReady &&= released || (ready && record.stable >= 2);
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
          if (!record.element.querySelector("[data-latex-preparation-spinner]")) {
            const spinner = globalThis.document.createElement("span");
            spinner.dataset.latexPreparationSpinner = "true";
            spinner.setAttribute("aria-hidden", "true");
            const label = globalThis.document.createElement("span");
            label.textContent = "Preparing page…";
            record.element.replaceChildren(spinner, label);
          }
          nextDeadline = Math.min(nextDeadline, record.started + maximumWaitMs);
        }
      }
      // Clipping affects paint only. Source DOM, native selection and measured
      // rectangles stay intact, while newly scrolled sheets and gaps cannot
      // expose ink before their page has passed the readiness fence.
      for (const page of focused) paintable.add(page);
      const origin = (view.dom.getBoundingClientRect().top - paperBox.top) / scale;
      const path = [...paintable]
        .map((page) => {
          const top = page * pitch - origin;
          const bottom = top + dimensions.pageHeight;
          return `M0 ${top}H${width}V${bottom}H0Z`;
        })
        .join(" ");
      const clip = path ? `path("${path}")` : "inset(100%)";
      if (view.dom.style.clipPath !== clip) view.dom.style.clipPath = clip;
      if (advance && demandChanged) {
        demand = nextDemand;
        demandLatexViewportPages(view, demand);
        queue();
      }
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
  const stopObserving = observeResize([scroll, paper], schedule);
  const layoutReady = () => {
    layoutSettlement++;
    schedule();
  };
  const scrolled = () => reconcile();
  const dependencies = new MutationObserver(schedule);
  dependencies.observe(view.dom, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-latex-preview-state"],
  });
  scroll.addEventListener("scroll", scrolled, { passive: true });
  view.dom.addEventListener("scient-latex-math-preview", schedule);
  view.dom.addEventListener("load", schedule, true);
  view.dom.addEventListener("error", schedule, true);
  view.dom.addEventListener("focus", schedule, true);
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
      scroll.removeEventListener("scroll", scrolled);
      view.dom.removeEventListener("scient-latex-math-preview", schedule);
      view.dom.removeEventListener("load", schedule, true);
      view.dom.removeEventListener("error", schedule, true);
      view.dom.removeEventListener("focus", schedule, true);
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
