import { afterEditorPaint } from "./afterEditorPaint";

/** Coalesce bookkeeping after input; the native editor continues painting immediately. */
export function createEditorBackgroundTask(quietMs = 120, maximumWaitMs = 1000) {
  let started: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelPaint: (() => void) | undefined;
  let pending: (() => void) | undefined;
  const cancel = () => {
    clearTimeout(timer);
    cancelPaint?.();
    timer = undefined;
    cancelPaint = undefined;
    pending = undefined;
    started = null;
  };
  const schedule = (callback: () => void) => {
    pending = callback;
    started ??= performance.now();
    clearTimeout(timer);
    cancelPaint?.();
    cancelPaint = undefined;
    const remaining = Math.max(0, maximumWaitMs - (performance.now() - started));
    timer = setTimeout(
      () => {
        timer = undefined;
        cancelPaint = afterEditorPaint(() => {
          const work = pending;
          cancel();
          work?.();
        });
      },
      Math.min(quietMs, remaining),
    );
  };
  return { schedule, cancel };
}
