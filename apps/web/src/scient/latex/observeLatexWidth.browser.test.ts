import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { observeLatexWidth } from "./observeLatexWidth";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settle = async () => {
  await frame();
  await frame();
  await frame();
};
const nativeClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!.get!;

describe("observed LaTeX layout width", () => {
  let panel: HTMLDivElement;
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    panel = document.createElement("div");
    panel.style.cssText =
      "box-sizing:border-box;width:420.5px;height:80px;padding:7.25px;border:3px solid black;overflow:auto;scrollbar-gutter:stable";
    const content = document.createElement("div");
    content.style.height = "200px";
    panel.append(content);
    document.body.append(panel);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    panel.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches client width across padding, borders, scrolling and transforms without geometry reads", async () => {
    const reads = vi.spyOn(panel, "clientWidth", "get");
    const widths: number[] = [];
    dispose = observeLatexWidth(panel, (width) => widths.push(width));
    expect(widths).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(panel));
    panel.style.width = "267.5px";
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(panel));
    panel.style.transform = "scale(0.6)";
    panel.style.paddingInline = "13.5px";
    panel.style.width = "330.5px";
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(panel));
    expect(panel.getBoundingClientRect().width).toBeLessThan(widths.at(-1)!);
    expect(reads).not.toHaveBeenCalled();
  });

  it("retains the last useful width while hidden and disconnects on cleanup", async () => {
    const widths: number[] = [];
    dispose = observeLatexWidth(panel, (width) => widths.push(width));
    await expect.poll(() => widths.length).toBe(1);
    panel.style.display = "none";
    await settle();
    expect(widths.length).toBe(1);
    panel.style.width = "275px";
    panel.style.display = "block";
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(panel));
    const count = widths.length;
    dispose();
    dispose = undefined;
    panel.style.width = "350px";
    await settle();
    expect(widths.length).toBe(count);
  });

  it("defers and cancels the compatibility measurement when ResizeObserver is unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const reads = vi.spyOn(panel, "clientWidth", "get");
    const widths: number[] = [];
    dispose = observeLatexWidth(panel, (width) => widths.push(width));
    expect(reads).not.toHaveBeenCalled();
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(panel));
    expect(reads).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    observeLatexWidth(panel, cancelled)();
    await settle();
    expect(cancelled).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
