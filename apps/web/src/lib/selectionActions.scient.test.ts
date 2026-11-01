import { describe, expect, it, vi } from "vite-plus/test";
import { observeSelectionActions } from "./selectionActions";

function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), values);
}

// A trusted text surface (PDF quotes, citations) prevents pointerdown for its own
// selection handling, then still needs the selection actions once the gesture ends.
function finishPreventedGesture(allowPreventedSelectionStart: boolean) {
  const frames: FrameRequestCallback[] = [];
  const view = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    cancelAnimationFrame: () => {},
  });
  const document = Object.assign(new EventTarget(), { defaultView: view, activeElement: null });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (target: unknown) => target === element,
    closest: () => null,
  });
  const onSelection = vi.fn();
  observeSelectionActions({
    element: element as unknown as HTMLElement,
    ...(allowPreventedSelectionStart
      ? { allowPreventedSelectionStart: (target: EventTarget | null) => target === element }
      : {}),
    onSelection,
    onDismiss: vi.fn(),
  });

  const press = event("pointerdown", { button: 0, isPrimary: true });
  Object.defineProperty(press, "target", { value: element });
  document.dispatchEvent(press);
  press.preventDefault();
  element.dispatchEvent(press);
  view.dispatchEvent(event("pointerup", { isPrimary: true, button: 0 }));
  view.dispatchEvent(event("mouseup", { clientX: 240, clientY: 160, detail: 1, button: 0 }));
  for (const frame of frames.splice(0)) frame(0);
  return onSelection;
}

describe("selection action gestures", () => {
  it("allows an explicitly trusted text surface to finish a prevented selection gesture", () => {
    expect(finishPreventedGesture(true)).toHaveBeenCalledWith({ x: 240, y: 160 });
  });

  it("keeps prevented gestures suppressed unless the surface explicitly opts in", () => {
    expect(finishPreventedGesture(false)).not.toHaveBeenCalled();
  });
});
