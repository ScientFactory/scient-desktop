import { afterEditorPaint } from "./afterEditorPaint";

/** Observe the unscaled client width without forcing layout during a React commit. */
export function observeLatexWidth(element: HTMLElement, onWidth: (width: number) => void) {
  let previous: number | undefined;
  const publish = (width: number) => {
    if (!Number.isFinite(width) || width <= 0 || width === previous) return;
    previous = width;
    onWidth(width);
  };
  if (typeof ResizeObserver === "undefined")
    return afterEditorPaint(() => publish(element.clientWidth));

  const observer = new ResizeObserver((entries) => {
    const entry = entries.find((entry) => entry.target === element);
    if (!entry || entry.contentRect.width <= 0) return;
    // The content box excludes padding and scrollbars. clientWidth includes
    // padding but excludes borders/scrollbars, and is rounded to CSS pixels.
    const style = getComputedStyle(element);
    const padding =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    publish(Math.round(entry.contentRect.width + padding));
  });
  observer.observe(element);
  return () => observer.disconnect();
}
