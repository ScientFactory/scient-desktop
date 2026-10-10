import { afterEditorPaint } from "./afterEditorPaint";

/** Fit responsive controls after paint, coalescing size and content notifications. */
export function observeLatexHeaderFit(row: HTMLElement, steps: readonly string[]) {
  let disposed = false;
  let cancelPending: (() => void) | undefined;
  const fit = () => {
    cancelPending = undefined;
    if (disposed || !row.isConnected || row.clientWidth <= 0) return;
    const hidden: string[] = [];
    row.dataset.fit = "";
    for (const step of steps) {
      if (row.scrollWidth <= row.clientWidth + 1) break;
      hidden.push(step);
      row.dataset.fit = hidden.join(" ");
    }
  };
  const schedule = () => {
    if (!disposed && !cancelPending) cancelPending = afterEditorPaint(fit);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(row);
  // Attribute changes include our own fitting output. Only document-owned
  // content changes (page/zoom/status and hosted controls) require refitting.
  const content = new MutationObserver(schedule);
  content.observe(row, { childList: true, subtree: true, characterData: true });
  schedule();
  return () => {
    disposed = true;
    cancelPending?.();
    resize.disconnect();
    content.disconnect();
  };
}
