import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeSelectionActions } from "./selectionActions";

function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), values);
}

function createSelectionSurface({
  interactiveActions = false,
  restoreAfterScroll = false,
  allowPreventedSelectionStart = false,
} = {}) {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const view = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const document = Object.assign(new EventTarget(), {
    defaultView: view,
    activeElement: null as EventTarget | null,
  });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (target: unknown): boolean => target === element || target === buttonIcon,
    closest: () => null,
  });
  const button = new EventTarget();
  const buttonIcon = Object.assign(new EventTarget(), {
    closest: (selector: string) => (selector === "button, [role=button]" ? button : null),
  });
  const onSelection = vi.fn();
  const onDismiss = vi.fn();
  const field = new EventTarget();
  const actionElement = Object.assign(new EventTarget(), {
    contains: (target: unknown) => target === actionElement || target === field,
  });
  const actions = observeSelectionActions({
    element: element as unknown as HTMLElement,
    ...(interactiveActions
      ? { getActionElement: () => actionElement as unknown as HTMLElement }
      : {}),
    ...(allowPreventedSelectionStart
      ? { allowPreventedSelectionStart: (target: EventTarget | null) => target === element }
      : {}),
    restoreAfterScroll,
    onSelection,
    onDismiss,
  });
  document.addEventListener("selectionchange", actions.selectionChanged);
  const change = () => document.dispatchEvent(event("selectionchange"));
  const down = ({
    inside = true,
    button = 0,
    consumed = false,
    prevented = false,
    isPrimary = true,
    target = inside ? element : document,
  }: {
    inside?: boolean;
    button?: number;
    consumed?: boolean;
    prevented?: boolean;
    isPrimary?: boolean;
    target?: EventTarget;
  } = {}) => {
    const press = event("pointerdown", { button, isPrimary });
    Object.defineProperty(press, "target", { value: target });
    document.dispatchEvent(press);
    if (prevented) press.preventDefault();
    if (element.contains(target) && !consumed) element.dispatchEvent(press);
  };
  const focus = (target: EventTarget) => {
    document.activeElement = target;
    const focusEvent = event("focusin");
    Object.defineProperty(focusEvent, "target", { value: target });
    document.dispatchEvent(focusEvent);
  };
  const key = (key: string, target: EventTarget = document) => {
    const keyEvent = event("keydown", { key });
    Object.defineProperty(keyEvent, "target", { value: target });
    document.dispatchEvent(keyEvent);
  };
  const pointerUp = (button = 0) => {
    view.dispatchEvent(event("pointerup", { isPrimary: true, button }));
  };
  const up = ({ x = 300, y = 200, detail = 1, button = 0 } = {}) => {
    pointerUp(button);
    view.dispatchEvent(event("mouseup", { clientX: x, clientY: y, detail, button }));
  };
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const flush = (milliseconds = 0) => {
    vi.advanceTimersByTime(milliseconds);
    flushFrame();
  };
  return {
    actions,
    view,
    document,
    element,
    buttonIcon,
    actionElement,
    field,
    onSelection,
    onDismiss,
    down,
    focus,
    key,
    up,
    pointerUp,
    change,
    flush,
    flushFrame,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("selection action gestures", () => {
  it("allows an explicitly trusted text surface to finish a prevented selection gesture", () => {
    const surface = createSelectionSurface({ allowPreventedSelectionStart: true });
    surface.down({ prevented: true });
    surface.up({ x: 240, y: 160 });
    surface.flush();
    expect(surface.onSelection).toHaveBeenCalledWith({ x: 240, y: 160 });
  });

  it("keeps prevented gestures suppressed unless the surface explicitly opts in", () => {
    const surface = createSelectionSurface();
    surface.down({ prevented: true });
    surface.up();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
  });
});
