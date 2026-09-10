import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useScientDownloadProgress } from "./useScientDownloadProgress";

type Props = Parameters<typeof useScientDownloadProgress>[0];
let props: Props;
let result: number | null;
let renderer: ReactTestRenderer;
let events: EventTarget;
let hidden: boolean;
let now: number;
let id: number;
const frames = new Map<number, FrameRequestCallback>();
function Probe(input: Props) {
  const value = useScientDownloadProgress(input);
  useLayoutEffect(() => {
    result = value;
  });
  return null;
}
async function update(patch: Partial<Props>) {
  props = { ...props, ...patch };
  await act(() => renderer.update(<Probe {...props} />));
}
async function step(ms = 16) {
  now += ms;
  const pending = [...frames.values()];
  frames.clear();
  await act(() => pending.forEach((callback) => callback(now)));
}
beforeEach(async () => {
  now = 0;
  id = 0;
  hidden = false;
  frames.clear();
  events = new EventTarget();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  props = { status: "downloading", version: "1.2.0", percent: 0, reducedMotion: false };
  await act(() => {
    renderer = create(<Probe {...props} />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("holds zero until a real reading, then smoothly catches up and stops", async () => {
  expect(result).toBe(0);
  expect(frames.size).toBe(0);
  await update({ percent: 30 });
  await step();
  expect(result).toBeGreaterThan(0);
  expect(result).toBeLessThan(1);
  for (let i = 0; i < 300; i++) await step();
  expect(result).toBe(30);
  expect(frames.size).toBe(0);
});
it("retargets without snapping and honors downward corrections", async () => {
  await update({ percent: 30 });
  await step();
  const before = result;
  await update({ percent: 60 });
  expect(result).toBe(before);
  await step();
  expect(result).toBeGreaterThan(before!);
  expect(result).toBeLessThan(60);
  await update({ percent: 0.1 });
  expect(result).toBe(0.1);
  expect(frames.size).toBe(0);
});
it.each(["available", "downloaded", "error"])(
  "cancels animation immediately on %s",
  async (status) => {
    await update({ percent: 60 });
    await step();
    await update({ status, percent: status === "downloaded" ? 100 : null });
    expect(result).toBe(props.percent);
    expect(frames.size).toBe(0);
    await update({ status: "downloading", percent: 0 });
    expect(result).toBe(0);
  },
);
it("resets for a different version and for missing readings", async () => {
  await update({ percent: 50 });
  await step();
  await update({ version: "1.3.0", percent: 20 });
  expect(result).toBe(20);
  await update({ percent: NaN });
  expect(result).toBeNull();
  expect(frames.size).toBe(0);
  await update({ percent: 40 });
  expect(result).toBe(40);
});
it("uses direct progress with reduced motion", async () => {
  await update({ percent: 50 });
  await step();
  await update({ reducedMotion: true });
  expect(result).toBe(50);
  expect(frames.size).toBe(0);
});
it("synchronizes hidden windows and cancels stale frames on unmount", async () => {
  await update({ percent: 50 });
  await step();
  hidden = true;
  await act(() => events.dispatchEvent(new Event("visibilitychange")));
  expect(result).toBe(50);
  expect(frames.size).toBe(0);
  await update({ percent: 60 });
  expect(result).toBe(60);
  hidden = false;
  await act(() => events.dispatchEvent(new Event("visibilitychange")));
  await update({ percent: 70 });
  const stale = [...frames.values()][0];
  await act(() => renderer.unmount());
  expect(frames.size).toBe(0);
  await act(() => stale?.(now + 16));
  expect(frames.size).toBe(0);
});
