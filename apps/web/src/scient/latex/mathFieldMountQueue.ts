import { afterLatexInputQuiet, latexInputQuietDelay } from "./latexInputPriority";

const pending = new Map<() => void, () => number>();
const priorities = new WeakMap<Element, number>();
const visibleCallbacks = new WeakMap<Element, () => void>();
let visibility: IntersectionObserver | undefined;

/** One observer prioritizes the visible formulas without repeated layout reads. */
export function observeMathReadingPriority(element: Element, onVisible?: () => void) {
  if (onVisible) visibleCallbacks.set(element, onVisible);
  priorities.set(element, 1);
  if (typeof IntersectionObserver !== "undefined") {
    visibility ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          priorities.set(entry.target, entry.isIntersecting ? 2 : 0);
          if (entry.isIntersecting) visibleCallbacks.get(entry.target)?.();
        }
      },
      { rootMargin: "300px" },
    );
    visibility.observe(element);
  }
  return () => {
    visibility?.unobserve(element);
    priorities.delete(element);
    visibleCallbacks.delete(element);
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
      if (value >= 2) break;
    }
  }
  return { mount: chosen!, priority: maximum };
}
let cancelBatch: (() => void) | undefined;

type PreviewTaskScheduler = {
  postTask(
    callback: () => void,
    options: { priority: "user-visible"; signal: AbortSignal },
  ): Promise<unknown>;
};

function queuePreviewBatch(callback: () => void, deferForInput: boolean) {
  let active = true;
  const run = () => {
    if (!active) return;
    active = false;
    callback();
  };
  const scheduler = (globalThis as typeof globalThis & { scheduler?: PreviewTaskScheduler })
    .scheduler;
  if (!deferForInput && scheduler?.postTask) {
    const controller = new AbortController();
    void scheduler
      .postTask(run, { priority: "user-visible", signal: controller.signal })
      .catch((error) => {
        if (!controller.signal.aborted) reportError(error);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }
  const timer = setTimeout(run, deferForInput ? 16 : 0);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

function scheduleBatch(deferForInput = false) {
  if (cancelBatch || pending.size === 0) return;
  // Preview work must progress even when an occluded window receives sparse
  // animation frames. Normal-priority tasks avoid starvation behind page reflow;
  // the input checks and four-millisecond budget still yield to editing and paint.
  cancelBatch = queuePreviewBatch(() => {
    cancelBatch = undefined;
    const start = performance.now();
    let waitingForInput = false;
    try {
      while (pending.size > 0) {
        const scheduling = (
          navigator as Navigator & { scheduling?: { isInputPending: () => boolean } }
        ).scheduling;
        if (scheduling?.isInputPending()) {
          waitingForInput = true;
          break;
        }
        const { mount, priority } = nextJob();
        if (priority < 2 && latexInputQuietDelay() > 0) {
          cancelBatch = afterLatexInputQuiet(() => {
            cancelBatch = undefined;
            scheduleBatch();
          });
          break;
        }
        mount();
        if (performance.now() - start >= 4) break;
      }
    } finally {
      scheduleBatch(waitingForInput);
    }
  }, deferForInput);
}

/** Yield between math render jobs; input and explicit editing take priority. */
export function scheduleMathFieldMount(mount: () => void, priority: () => number = () => 0) {
  const run = () => {
    if (!pending.delete(run)) return;
    mount();
  };
  pending.set(run, priority);
  if (priority() >= 2) {
    cancelBatch?.();
    cancelBatch = undefined;
  }
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
