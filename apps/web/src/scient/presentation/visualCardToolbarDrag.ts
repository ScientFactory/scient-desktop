type Position = { x: number; y: number };

const CARD_INSET = 4;
const DRAG_THRESHOLD = 3;
const INTERACTIVE_CONTROL =
  'button, a, input, select, textarea, label, summary, [contenteditable], [tabindex], [role="button"], [role="slider"]';

/** Move only the toolbar, leaving the renderer and its layout untouched. */
export function attachVisualCardToolbarDrag(
  toolbar: HTMLElement,
  handle: HTMLButtonElement,
  onDraggingChange: (dragging: boolean) => void = () => {},
  canDrag: () => boolean = () => true,
) {
  const card = toolbar.closest<HTMLElement>("[data-scient-visual-card]");
  if (!card) return Object.assign(() => {}, { reset: () => {} });

  let position: Position = { x: 0, y: 0 };
  let drag: {
    pointerId: number;
    start: Position;
    pointer: Position;
    latest: Position;
    moved: boolean;
    resetOnClick: boolean;
  } | null = null;
  let frame: number | null = null;
  let observer: ResizeObserver | null = null;
  let suppressClick = false;
  const listeners = new AbortController();

  const move = (next: Position) => {
    // Read together, then write once. Translation does not resize the chart.
    const bounds = card.getBoundingClientRect();
    const rect = toolbar.getBoundingClientRect();
    const minX = bounds.left + CARD_INSET - (rect.left - position.x);
    const minY = bounds.top + CARD_INSET - (rect.top - position.y);
    const maxX = minX + Math.max(0, bounds.width - rect.width - CARD_INSET * 2);
    const maxY = minY + Math.max(0, bounds.height - rect.height - CARD_INSET * 2);
    const clamped = {
      x: Math.max(minX, Math.min(maxX, next.x)),
      y: Math.max(minY, Math.min(maxY, next.y)),
    };
    if (clamped.x === position.x && clamped.y === position.y) return;
    position = clamped;
    if (position.x === 0 && position.y === 0) {
      toolbar.style.removeProperty("translate");
      observer?.disconnect();
      observer = null;
      return;
    }
    toolbar.style.translate = `${position.x}px ${position.y}px`;

    // Default/unmoved cards incur no observation work. Re-clamp a moved toolbar
    // if the panel, image, source disclosure, or toolbar itself changes size.
    if (!observer && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => move(position));
      observer.observe(card);
      observer.observe(toolbar);
    }
  };

  function applyPointer() {
    if (!drag) return;
    const dx = drag.latest.x - drag.pointer.x;
    const dy = drag.latest.y - drag.pointer.y;
    drag.moved ||= Math.hypot(dx, dy) > DRAG_THRESHOLD;
    if (drag.moved) move({ x: drag.start.x + dx, y: drag.start.y + dy });
  }

  function endDrag(cancel: boolean) {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const previous = drag;
    drag = null;
    if (!previous) return;
    onDraggingChange(false);
    // Capture can retarget the release click to the grip even when the gesture
    // began on empty space. Only a deliberate, uncancelled grip tap resets.
    suppressClick = previous.moved || !previous.resetOnClick || cancel;
    if (cancel && previous.moved) move(previous.start);
    if (handle.hasPointerCapture(previous.pointerId)) {
      handle.releasePointerCapture(previous.pointerId);
    }
  }

  function reset() {
    endDrag(false);
    position = { x: 0, y: 0 };
    toolbar.style.removeProperty("translate");
    observer?.disconnect();
    observer = null;
  }

  function beginDrag(event: PointerEvent, resetOnClick: boolean) {
    if (!canDrag() || event.defaultPrevented || event.button !== 0 || !event.isPrimary || drag)
      return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
    drag = {
      pointerId: event.pointerId,
      start: { ...position },
      pointer: { x: event.clientX, y: event.clientY },
      latest: { x: event.clientX, y: event.clientY },
      moved: false,
      resetOnClick,
    };
    onDraggingChange(true);
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
  }

  handle.addEventListener("pointerdown", (event) => beginDrag(event, true), {
    signal: listeners.signal,
  });
  toolbar.addEventListener(
    "pointerdown",
    (event) => {
      // Native listeners stay inside this toolbar; menu portals are not drag
      // surfaces. Check ancestors too, so icons inside controls stay clickable.
      if (event.target !== toolbar) {
        if (!(event.target instanceof Element)) return;
        const control = event.target.closest(INTERACTIVE_CONTROL);
        if (control && toolbar.contains(control)) return;
      }
      beginDrag(event, false);
    },
    { signal: listeners.signal },
  );

  handle.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      drag.latest = { x: event.clientX, y: event.clientY };
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        applyPointer();
      });
    },
    { signal: listeners.signal },
  );

  handle.addEventListener(
    "pointerup",
    (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      drag.latest = { x: event.clientX, y: event.clientY };
      applyPointer();
      endDrag(false);
    },
    { signal: listeners.signal },
  );

  const cancelPointer = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) endDrag(true);
  };
  handle.addEventListener("pointercancel", cancelPointer, { signal: listeners.signal });
  handle.addEventListener("lostpointercapture", cancelPointer, { signal: listeners.signal });
  handle.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!suppressClick) reset();
      suppressClick = false;
    },
    { signal: listeners.signal },
  );

  handle.addEventListener(
    "keydown",
    (event) => {
      if (!canDrag()) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // Keyboard activation must still reset if a browser omitted the click
      // following an earlier pointer drag.
      if (event.key === "Enter" || event.key === " ") suppressClick = false;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        event.stopPropagation();
        endDrag(true);
        return;
      }
      if (
        event.key !== "Home" &&
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
      suppressClick = false;
      if (event.key === "Home") {
        reset();
        return;
      }
      const step = event.shiftKey ? 1 : 10;
      move({
        x: position.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        y: position.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
      });
    },
    { signal: listeners.signal },
  );

  return Object.assign(
    () => {
      listeners.abort();
      reset();
    },
    { reset },
  );
}
