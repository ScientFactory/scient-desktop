import { afterEditorPaint } from "./afterEditorPaint";

const pending = new Map<() => void, () => number>();
const priorities = new WeakMap<Element, number>();
let visibility: IntersectionObserver | undefined;

/** One observer prioritizes the visible formulas without repeated layout reads. */
export function observeMathReadingPriority(element: Element) {
  priorities.set(element, 1);
  if (typeof IntersectionObserver !== "undefined") {
    visibility ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) priorities.set(entry.target, entry.isIntersecting ? 2 : 0);
      },
      { rootMargin: "300px" },
    );
    visibility.observe(element);
  }
  return () => {
    visibility?.unobserve(element);
    priorities.delete(element);
  };
}

export const mathReadingPriority = (element: Element) => priorities.get(element) ?? 0;

function nextJob() {
  let chosen: (() => void) | undefined;
  let maximum = -Infinity;
  for (const [job, priority] of pending) {
    const value = priority();
    if (value > maximum) {
      chosen = job;
      maximum = value;
    }
  }
  return chosen!;
}
let cancelBatch: (() => void) | undefined;

function scheduleBatch() {
  if (cancelBatch || pending.size === 0) return;
  cancelBatch = afterEditorPaint(() => {
    cancelBatch = undefined;
    const start = performance.now();
    while (pending.size > 0) {
      const scheduling = (
        navigator as Navigator & { scheduling?: { isInputPending: () => boolean } }
      ).scheduling;
      if (scheduling?.isInputPending()) break;
      const mount = nextJob();
      mount();
      if (performance.now() - start >= 4) break;
    }
    scheduleBatch();
  });
}

/** Yield between math render jobs; input and explicit editing take priority. */
export function scheduleMathFieldMount(mount: () => void, priority: () => number = () => 0) {
  const run = () => {
    if (!pending.delete(run)) return;
    mount();
  };
  pending.set(run, priority);
  scheduleBatch();
  return {
    flush: run,
    cancel: () => {
      pending.delete(run);
      if (pending.size === 0) {
        cancelBatch?.();
        cancelBatch = undefined;
      }
    },
  };
}
