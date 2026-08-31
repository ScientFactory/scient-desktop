import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { attachVisualCardToolbarDrag } from "./visualCardToolbarDrag";

const frames = new Map<number, FrameRequestCallback>();
const observers: { fire: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
const cleanups: (() => void)[] = [];

class ElementTarget extends EventTarget {
  constructor(
    private readonly selectors: readonly string[] = [],
    private readonly parent: ElementTarget | null = null,
  ) {
    super();
  }

  closest(selectors: string): ElementTarget | null {
    return selectors.split(",").some((selector) => this.selectors.includes(selector.trim()))
      ? this
      : (this.parent?.closest(selectors) ?? null);
  }

  contains(target: ElementTarget): boolean {
    return target === this || (target.parent !== null && this.contains(target.parent));
  }
}

beforeEach(() => {
  vi.stubGlobal("Element", ElementTarget);
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: () => void) {
        observers.push({ fire: callback, disconnect: this.disconnect });
      }
    },
  );
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  frames.clear();
  observers.length = 0;
  vi.unstubAllGlobals();
});

function flushFrame() {
  const queued = [...frames.values()];
  frames.clear();
  queued.forEach((callback) => callback(0));
}

function event(
  target: EventTarget,
  type: string,
  fields: Record<string, unknown> = {},
  origin: EventTarget = target,
) {
  const input = Object.assign(new Event(type, { cancelable: true }), fields);
  Object.defineProperty(input, "target", { value: origin });
  target.dispatchEvent(input);
  return input;
}

function fixture(focusableCard = false) {
  const bounds = { left: 100, top: 100, width: 400, height: 300 };
  const size = { width: 100, height: 32 };
  const style = {
    translate: "",
    removeProperty: (name: string) => {
      if (name === "translate") style.translate = "";
    },
  };
  const position = () => (style.translate ? style.translate.split(" ").map(parseFloat) : [0, 0]);
  const card = Object.assign(
    new ElementTarget(["[data-scient-visual-card]", ...(focusableCard ? ["[tabindex]"] : [])]),
    {
      getBoundingClientRect: () => ({ ...bounds }),
    },
  );
  const toolbar = Object.assign(new ElementTarget([], card), {
    style,
    getBoundingClientRect: () => {
      const [x = 0, y = 0] = position();
      return {
        left: bounds.left + bounds.width - size.width - 4 + x,
        top: bounds.top + 4 + y,
        ...size,
      };
    },
  });
  const captured = new Set<number>();
  const handle = Object.assign(new ElementTarget(["button"], toolbar), {
    focus: vi.fn(),
    hasPointerCapture: (id: number) => captured.has(id),
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
      event(handle, "lostpointercapture", { pointerId: id });
    },
  });
  // Node has EventTarget but no layout engine. These doubles exercise real
  // event/capture/cleanup transitions with deterministic card measurements.
  const attach = () =>
    attachVisualCardToolbarDrag(
      toolbar as unknown as HTMLElement,
      handle as unknown as HTMLButtonElement,
    );
  const cleanup = attach();
  cleanups.push(cleanup);
  const pointer = (type: string, x: number, y: number, fields: Record<string, unknown> = {}) =>
    event(handle, type, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: x,
      clientY: y,
      ...fields,
    });
  const backgroundDown = (origin: EventTarget = toolbar, fields: Record<string, unknown> = {}) =>
    event(
      toolbar,
      "pointerdown",
      { button: 0, isPrimary: true, pointerId: 1, clientX: 400, clientY: 120, ...fields },
      origin,
    );
  const key = (value: string, fields: Record<string, unknown> = {}) =>
    event(handle, "keydown", { key: value, ...fields });
  return {
    toolbar,
    handle,
    bounds,
    size,
    position,
    pointer,
    backgroundDown,
    key,
    captured,
    cleanup,
    attach,
  };
}

describe("visual-card toolbar movement", () => {
  it("keeps the authored default position and does not observe unmoved cards", () => {
    const f = fixture();
    expect(f.toolbar.style.translate).toBe("");
    expect(observers).toHaveLength(0);
    expect(event(f.toolbar, "pointerdown").defaultPrevented).toBe(false);
    expect(event(f.toolbar, "click").defaultPrevented).toBe(false);
  });

  it("captures the handle and coalesces movement to the latest pointer once per frame", () => {
    const f = fixture();
    expect(f.pointer("pointerdown", 400, 120).defaultPrevented).toBe(true);
    expect(f.captured.has(1)).toBe(true);
    expect(f.handle.focus).toHaveBeenCalledWith({ preventScroll: true });
    f.pointer("pointermove", 370, 180);
    f.pointer("pointermove", 340, 200);
    expect(frames.size).toBe(1);
    expect(f.position()).toEqual([0, 0]);
    flushFrame();
    expect(f.position()).toEqual([-60, 80]);
    expect(observers).toHaveLength(1);
  });

  it.each(["background", "separator"])("drags from unused toolbar %s", (surface) => {
    const f = fixture();
    const target = surface === "background" ? f.toolbar : new ElementTarget([], f.toolbar);
    expect(f.backgroundDown(target).defaultPrevented).toBe(true);
    expect(f.captured.has(1)).toBe(true);
    f.pointer("pointermove", 350, 170);
    flushFrame();
    expect(f.position()).toEqual([-50, 50]);
    f.pointer("pointerup", 340, 180);
    event(f.handle, "click");
    expect(f.position()).toEqual([-60, 60]);
    expect(f.captured.size).toBe(0);
  });

  it("does not reset on a background tap retargeted to the capture handle", () => {
    const f = fixture();
    f.key("ArrowLeft");
    f.backgroundDown();
    f.pointer("pointerup", 401, 121);
    event(f.handle, "click");
    expect(f.position()).toEqual([-10, 0]);
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointerup", 400, 120);
    event(f.handle, "click");
    expect(f.position()).toEqual([0, 0]);
  });

  it("does not mistake a focusable ancestor outside the toolbar for one of its controls", () => {
    const f = fixture(true);
    expect(f.backgroundDown(new ElementTarget([], f.toolbar)).defaultPrevented).toBe(true);
    f.pointer("pointerup", 350, 170);
    expect(f.position()).toEqual([-50, 50]);
  });

  it.each([
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "label",
    "summary",
    "[contenteditable]",
    "[tabindex]",
    '[role="button"]',
    '[role="slider"]',
  ])("does not drag from a %s control or its nested icon", (selector) => {
    const f = fixture();
    const control = new ElementTarget([selector], f.toolbar);
    const icon = new ElementTarget([], control);
    for (const target of [control, icon]) {
      expect(f.backgroundDown(target).defaultPrevented).toBe(false);
    }
    expect(f.captured.size).toBe(0);
    expect(f.handle.focus).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    const action = vi.fn();
    control.addEventListener("click", action);
    event(control, "click");
    expect(action).toHaveBeenCalledOnce();
  });

  it("leaves disabled controls and later action clicks alone after a background drag", () => {
    const f = fixture();
    const control = Object.assign(new ElementTarget(["button"], f.toolbar), { disabled: true });
    expect(f.backgroundDown(control).defaultPrevented).toBe(false);
    f.backgroundDown();
    f.pointer("pointerup", 350, 170);
    control.disabled = false;
    expect(f.backgroundDown(control).defaultPrevented).toBe(false);
    const action = vi.fn();
    control.addEventListener("click", action);
    event(control, "click");
    expect(action).toHaveBeenCalledOnce();
    expect(f.position()).toEqual([-50, 50]);
  });

  it("supports touch background dragging and Escape without resetting the earlier position", () => {
    const f = fixture();
    f.key("ArrowLeft");
    f.backgroundDown(f.toolbar, { pointerType: "touch" });
    expect(f.captured.has(1)).toBe(true);
    f.pointer("pointermove", 350, 170);
    flushFrame();
    f.key("Escape");
    expect(f.position()).toEqual([-10, 0]);
    expect(f.captured.size).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("does not reset a cancelled grip tap", () => {
    const f = fixture();
    f.key("ArrowLeft");
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointercancel", 400, 120);
    event(f.handle, "click");
    expect(f.position()).toEqual([-10, 0]);
  });

  it("clamps all four edges inside this card", () => {
    const f = fixture();
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointermove", -1000, 2000);
    flushFrame();
    expect(f.position()).toEqual([-292, 260]);
    f.pointer("pointermove", 2000, -1000);
    flushFrame();
    expect(f.position()).toEqual([0, 0]);
  });

  it("supports the primary touch pointer, ignoring right clicks and other pointers", () => {
    const f = fixture();
    expect(f.pointer("pointerdown", 400, 120, { button: 2 }).defaultPrevented).toBe(false);
    expect(f.pointer("pointerdown", 400, 120, { isPrimary: false }).defaultPrevented).toBe(false);
    f.pointer("pointerdown", 400, 120, { pointerType: "touch" });
    f.pointer("pointerdown", 500, 500, { pointerId: 2 });
    f.pointer("pointermove", 900, 900, { pointerId: 2 });
    f.pointer("pointerup", 900, 900, { pointerId: 2 });
    f.pointer("pointermove", 350, 170, { pointerType: "touch" });
    flushFrame();
    expect(f.position()).toEqual([-50, 50]);
  });

  it("commits the final pointer position and suppresses the post-drag reset click", () => {
    const f = fixture();
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointermove", 370, 150);
    f.pointer("pointerup", 320, 220);
    expect(frames.size).toBe(0);
    expect(f.captured.size).toBe(0);
    expect(f.position()).toEqual([-80, 100]);
    event(f.handle, "click");
    expect(f.position()).toEqual([-80, 100]);
    event(f.handle, "click");
    expect(f.toolbar.style.translate).toBe("");
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "restores the pre-drag position on %s",
    (type) => {
      const f = fixture();
      f.key("ArrowLeft");
      f.pointer("pointerdown", 400, 120);
      f.pointer("pointermove", 350, 170);
      flushFrame();
      f.pointer(type, 350, 170);
      expect(f.position()).toEqual([-10, 0]);
      expect(f.captured.size).toBe(0);
    },
  );

  it("cancels with Escape, including any queued movement", () => {
    const f = fixture();
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointermove", 350, 170);
    flushFrame();
    f.pointer("pointermove", 300, 200);
    f.key("Escape");
    expect(f.toolbar.style.translate).toBe("");
    expect(frames.size).toBe(0);
    expect(f.captured.size).toBe(0);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it("supports keyboard and precise movement, leaving modified app shortcuts alone", () => {
    const f = fixture();
    f.key("ArrowLeft");
    f.key("ArrowDown");
    f.key("ArrowLeft", { shiftKey: true });
    expect(f.position()).toEqual([-11, 10]);
    expect(f.key("ArrowLeft", { metaKey: true }).defaultPrevented).toBe(false);
    f.key("Home");
    expect(f.toolbar.style.translate).toBe("");
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it.each(["Enter", " "])(
    "resets by keyboard activation after a drag with no synthetic click (%s)",
    (key) => {
      const f = fixture();
      f.pointer("pointerdown", 400, 120);
      f.pointer("pointerup", 350, 170);
      expect(f.key(key).defaultPrevented).toBe(false);
      event(f.handle, "click");
      expect(f.toolbar.style.translate).toBe("");
    },
  );

  it("does not mistake a slightly shaky tap for a drag", () => {
    const f = fixture();
    f.key("ArrowLeft");
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointerup", 401, 121);
    event(f.handle, "click");
    expect(f.position()).toEqual([0, 0]);
  });

  it("keeps controls reachable when a card or toolbar resizes after moving", () => {
    const f = fixture();
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointerup", -1000, 2000);
    f.bounds.width = 160;
    f.bounds.height = 120;
    observers[0]?.fire();
    expect(f.position()).toEqual([-52, 80]);
    f.size.height = 60;
    observers[0]?.fire();
    expect(f.position()).toEqual([-52, 52]);
  });

  it("keeps positions independent between cards", () => {
    const first = fixture();
    const second = fixture();
    first.key("ArrowLeft");
    second.key("ArrowDown");
    first.key("Home");
    expect(second.position()).toEqual([0, 10]);
  });

  it("cleans up capture, listeners, queued frames and observers on unmount", () => {
    const f = fixture();
    f.pointer("pointerdown", 400, 120);
    f.pointer("pointermove", 350, 170);
    flushFrame();
    f.pointer("pointermove", 300, 220);
    f.cleanup();
    expect(frames.size).toBe(0);
    expect(f.captured.size).toBe(0);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    f.key("ArrowLeft");
    expect(f.backgroundDown().defaultPrevented).toBe(false);
    expect(f.position()).toEqual([0, 0]);
    cleanups.push(f.attach());
    f.key("ArrowLeft");
    expect(f.position()).toEqual([-10, 0]);
  });
});
