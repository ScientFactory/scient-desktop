import { describe, expect, it, vi } from "vite-plus/test";

import {
  PINCH_ZOOM_CHANNEL,
  pinchZoomFactor,
  reportPinchWheel,
  watchPinchZoom,
} from "./pinchZoom.ts";

const makeGuest = () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const guest = {
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    off: vi.fn(),
    ipc: {
      on: (channel: string, listener: (...args: unknown[]) => void) =>
        listeners.set(channel, listener),
      off: vi.fn(),
    },
  };
  const fire = (event: string, ...args: unknown[]) => listeners.get(event)?.({}, ...args);
  return { guest: guest as unknown as Parameters<typeof watchPinchZoom>[0], fire };
};

describe("watchPinchZoom", () => {
  it("zooms by the page's ctrl+wheel deltas only during a pinch and as it settles", () => {
    const { guest, fire } = makeGuest();
    const pinch = vi.fn<(deltaY: number) => void>();
    let now = 1_000;
    watchPinchZoom(guest, { pinch, step: vi.fn() }, () => now);

    // Ctrl+scroll reaches the page as the same ctrl+wheel, without a pinch gesture.
    fire(PINCH_ZOOM_CHANNEL, -12);
    fire("input-event", { type: "gesturePinchBegin" });
    fire(PINCH_ZOOM_CHANNEL, -5);
    fire(PINCH_ZOOM_CHANNEL, Number.NaN);
    fire("input-event", { type: "gesturePinchEnd" });
    // A busy page reports the pinch's last frames after it ends.
    now += 400;
    fire(PINCH_ZOOM_CHANNEL, -7);
    now += 200;
    fire(PINCH_ZOOM_CHANNEL, -9);

    expect(pinch.mock.calls).toEqual([[-5], [-7]]);
  });

  it("adds up a slow pinch's small steps, and ends the settling on new wheel input", () => {
    const { guest, fire } = makeGuest();
    const pinch = vi.fn<(deltaY: number) => void>();
    const step = vi.fn<(direction: "in" | "out") => void>();
    watchPinchZoom(guest, { pinch, step }, () => 1_000);

    fire("input-event", { type: "gesturePinchBegin" });
    for (let frame = 0; frame < 6; frame += 1) fire(PINCH_ZOOM_CHANNEL, -0.1);
    fire("input-event", { type: "gesturePinchEnd" });
    expect(pinch).toHaveBeenCalledOnce();
    expect(pinch.mock.calls[0]![0]).toBeCloseTo(-0.5);

    // Ctrl+mouse wheel right after the pinch is its own input, not the pinch's last frames.
    fire("input-event", { type: "mouseWheel" });
    fire(PINCH_ZOOM_CHANNEL, -12);
    fire("zoom-changed", "in");
    expect(pinch).toHaveBeenCalledOnce();
    expect(step.mock.calls).toEqual([["in"]]);
  });

  it("steps for ctrl+mouse wheel, but not for the wheel events of a pinch", () => {
    const { guest, fire } = makeGuest();
    const step = vi.fn<(direction: "in" | "out") => void>();
    let now = 1_000;
    watchPinchZoom(guest, { pinch: vi.fn(), step }, () => now);

    fire("zoom-changed", "out");
    fire("input-event", { type: "gesturePinchBegin" });
    fire("zoom-changed", "in");
    fire("input-event", { type: "gesturePinchEnd" });
    fire("zoom-changed", "in");
    now += 600;
    fire("zoom-changed", "in");

    expect(step.mock.calls).toEqual([["out"], ["in"]]);
  });
});

describe("pinchZoomFactor", () => {
  it("stays within the zoom steps and lands on a step it reaches", () => {
    const levels = [0.5, 1, 1.5, 2];
    expect(pinchZoomFactor(1, -100 * Math.log(1.2), levels)).toBeCloseTo(1.2);
    expect(pinchZoomFactor(1.4991, -0.05, levels)).toBe(1.5);
    expect(pinchZoomFactor(1.5, -100, levels)).toBe(2);
    expect(pinchZoomFactor(1, 100, levels)).toBe(0.5);
  });
});

describe("reportPinchWheel", () => {
  const makeWindow = () => {
    let wheel: ((event: WheelEvent) => void) | undefined;
    const tasks: Array<() => void> = [];
    const frames: Array<() => void> = [];
    const target = {
      addEventListener: (type: string, listener: (event: WheelEvent) => void) => {
        if (type === "wheel") wheel = listener;
      },
      setTimeout: (task: () => void) => tasks.push(task),
      requestAnimationFrame: (frame: () => void) => frames.push(frame),
    } as unknown as Window;
    const dispatch = (init: Partial<WheelEvent>, cancelledByPage = false) => {
      const event = {
        isTrusted: true,
        ctrlKey: true,
        deltaMode: 0,
        deltaY: 0,
        defaultPrevented: false,
        ...init,
      };
      wheel?.(event as WheelEvent);
      if (cancelledByPage) event.defaultPrevented = true;
    };
    const runTasks = () => tasks.splice(0).forEach((task) => task());
    const runFrame = () => frames.splice(0).forEach((frame) => frame());
    return { target, dispatch, runTasks, runFrame, frames };
  };

  it("reports one frame's uncancelled pinch deltas together", () => {
    const { target, dispatch, runTasks, runFrame, frames } = makeWindow();
    const send = vi.fn<(deltaY: number) => void>();
    reportPinchWheel(target, send);

    dispatch({ deltaY: -3 });
    dispatch({ deltaY: -2 });
    // A page that handles the pinch itself, such as a map, cancels its wheel events.
    dispatch({ deltaY: -40 }, true);
    dispatch({ deltaY: -40, isTrusted: false });
    dispatch({ deltaY: -40, ctrlKey: false });
    runTasks();
    expect(frames).toHaveLength(1);
    runFrame();
    dispatch({ deltaY: 4 });
    runTasks();
    runFrame();

    expect(send.mock.calls).toEqual([[-5], [4]]);
  });
});
