import type { MathfieldElement } from "mathlive";
import { afterEditorPaint } from "./afterEditorPaint";

/** Display math keeps its natural layout; panning belongs only to the live edit. */
export function installLatexMathViewport(math: MathfieldElement, viewport: HTMLElement) {
  // Inline fields and embedded math editors never own a display viewport.
  // Avoid document listeners and size observers for those frequent cases.
  if (!viewport.parentElement?.classList.contains("scient-latex-visual-display-math")) {
    return {
      setEditing: (_editing: boolean) => {},
      revealCaret: () => {},
      dispose: () => {},
    };
  }
  let editing = false;
  let rememberedOffset = 0;
  let restorePending = false;
  let caretPending = false;
  let pointerDown = false;
  let cancelUpdate: (() => void) | undefined;
  let maxScroll = 0;
  const isDisplay = () =>
    viewport.parentElement?.classList.contains("scient-latex-visual-display-math") === true;
  const update = () => {
    cancelUpdate = undefined;
    if (!isDisplay() || viewport.clientWidth === 0) {
      viewport.removeAttribute("data-math-viewport-active");
      viewport.removeAttribute("data-math-wide");
      maxScroll = 0;
      return;
    }
    const style = getComputedStyle(viewport);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const wide = math.offsetWidth > viewport.clientWidth - padding + 1;
    viewport.toggleAttribute("data-math-wide", wide);
    viewport.toggleAttribute("data-math-viewport-active", editing && wide);
    const max = editing && wide ? Math.max(0, viewport.scrollWidth - viewport.clientWidth) : 0;
    maxScroll = max;
    if (restorePending) {
      if (max > 0) viewport.scrollLeft = Math.min(max, rememberedOffset);
      restorePending = false;
    }
    if (caretPending && !pointerDown) {
      caretPending = false;
      if (max > 0 && math.hasFocus() && math.selectionIsCollapsed) {
        const caret = math.shadowRoot?.querySelector(".ML__caret,.ML__text-caret");
        const bounds = viewport.getBoundingClientRect();
        const ink = caret?.getBoundingClientRect();
        const scale = bounds.width / viewport.offsetWidth;
        if (ink && scale > 0) {
          if (ink.right > bounds.right - 8 * scale)
            viewport.scrollLeft = Math.min(
              max,
              viewport.scrollLeft + (ink.right - bounds.right) / scale + 8,
            );
          else if (ink.left < bounds.left + 8 * scale)
            viewport.scrollLeft = Math.max(
              0,
              viewport.scrollLeft + (ink.left - bounds.left) / scale - 8,
            );
        }
      }
    }
    if (editing && max > 0) rememberedOffset = viewport.scrollLeft;
  };
  const schedule = () => {
    if (!cancelUpdate) cancelUpdate = afterEditorPaint(update);
  };
  const setEditing = (next: boolean) => {
    if (editing === next) return;
    if (!next) {
      rememberedOffset = viewport.scrollLeft;
      viewport.removeAttribute("data-math-viewport-active");
      viewport.scrollLeft = 0;
      maxScroll = 0;
    }
    editing = next;
    // Clicking a new symbol must retain the clicked position. Restore a saved
    // viewport only for keyboard/programmatic re-entry, then reveal its caret.
    restorePending = next && !pointerDown;
    caretPending = next;
    schedule();
  };
  const revealCaret = () => {
    if (!editing) return;
    caretPending = true;
    schedule();
  };
  const wheel = (event: WheelEvent) => {
    if (!editing || event.ctrlKey || event.metaKey) return;
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta) return;
    // Measure before the first gesture, even if focus/resize paint is pending.
    cancelUpdate?.();
    update();
    if (!maxScroll) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
    const offset = Math.max(0, Math.min(maxScroll, viewport.scrollLeft + delta * unit));
    if (offset === viewport.scrollLeft) return;
    event.preventDefault();
    // The outer viewport owns panning; MathLive otherwise scrolls its own
    // content first and stops the event before it reaches this viewport.
    event.stopPropagation();
    viewport.scrollLeft = offset;
    schedule();
  };
  const pointerStarted = () => {
    pointerDown = true;
  };
  const pointerFinished = () => {
    if (!pointerDown) return;
    pointerDown = false;
    revealCaret();
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(viewport);
  resize.observe(math);
  viewport.addEventListener("scroll", schedule);
  viewport.addEventListener("wheel", wheel, { passive: false, capture: true });
  math.addEventListener("pointerdown", pointerStarted, true);
  math.ownerDocument.addEventListener("pointerup", pointerFinished, true);
  math.ownerDocument.addEventListener("pointercancel", pointerFinished, true);
  schedule();
  return {
    setEditing,
    revealCaret,
    dispose: () => {
      cancelUpdate?.();
      resize.disconnect();
      viewport.removeEventListener("scroll", schedule);
      viewport.removeEventListener("wheel", wheel, true);
      math.removeEventListener("pointerdown", pointerStarted, true);
      math.ownerDocument.removeEventListener("pointerup", pointerFinished, true);
      math.ownerDocument.removeEventListener("pointercancel", pointerFinished, true);
      viewport.removeAttribute("data-math-viewport-active");
      viewport.removeAttribute("data-math-wide");
      viewport.scrollLeft = 0;
    },
  };
}
