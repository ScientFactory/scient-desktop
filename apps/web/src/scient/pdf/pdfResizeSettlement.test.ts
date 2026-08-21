import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPdfResponsiveZoomController,
  type PdfResponsiveZoomTarget,
} from "./pdfResponsiveZoom";
import { createPdfResizeSettlement } from "./pdfResizeSettlement";

function createFrameClock() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    clock: {
      request: (callback: FrameRequestCallback) => {
        const handle = nextHandle;
        nextHandle += 1;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel: (handle: number) => {
        callbacks.delete(handle);
      },
    },
    flush: () => {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(0);
    },
    pending: () => callbacks.size,
  };
}

describe("PDF resize settlement", () => {
  it("waits for two unchanged paint frames", () => {
    const frames = createFrameClock();
    const onSettled = vi.fn();
    const settlement = createPdfResizeSettlement(onSettled, frames.clock);

    settlement.schedule();
    frames.flush();
    expect(onSettled).not.toHaveBeenCalled();

    frames.flush();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(frames.pending()).toBe(0);
  });

  it("restarts the stability window throughout a resize storm", () => {
    const frames = createFrameClock();
    const onSettled = vi.fn();
    const settlement = createPdfResizeSettlement(onSettled, frames.clock);

    for (let index = 0; index < 5_000; index += 1) {
      settlement.schedule();
      frames.flush();
    }
    expect(onSettled).not.toHaveBeenCalled();

    frames.flush();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("lets a manual action cancel queued responsive work", () => {
    const frames = createFrameClock();
    const onSettled = vi.fn();
    const settlement = createPdfResizeSettlement(onSettled, frames.clock);

    settlement.schedule();
    frames.flush();
    settlement.cancel();
    frames.flush();

    expect(onSettled).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
  });

  it("does not jump back after manual zoom cancels a pending resize", () => {
    const frames = createFrameClock();
    const controller = createPdfResponsiveZoomController();
    let currentScale = 1.25;
    let currentScaleValue = "1.25";
    const target: PdfResponsiveZoomTarget = {
      currentPageNumber: 1,
      get currentScale() {
        return currentScale;
      },
      set currentScale(value) {
        currentScale = value;
        currentScaleValue = String(value);
      },
      get currentScaleValue() {
        return currentScaleValue;
      },
      set currentScaleValue(value) {
        currentScaleValue = value;
      },
      getPageView: () => ({ width: 800 * currentScale, scale: currentScale }),
      update: vi.fn(),
    };
    controller.capturePreference(target);
    controller.reconcile(target, 600);
    expect(target.currentScale).toBeCloseTo(0.7);

    let settledWidth = 600;
    const settlement = createPdfResizeSettlement(
      () => controller.reconcile(target, settledWidth),
      frames.clock,
    );
    settlement.schedule();
    frames.flush();

    const manualScale = controller.rememberScale(0.75);
    target.currentScale = manualScale;
    controller.observeScaleChange(target, manualScale);
    settlement.cancel();
    frames.flush();

    expect(target.currentScale).toBe(0.75);
    expect(controller.persistedScaleValue()).toBe("0.75");

    settledWidth = 560;
    settlement.schedule();
    frames.flush();
    frames.flush();
    expect(target.currentScale).toBeCloseTo(0.65);
    expect(controller.persistedScaleValue()).toBe("0.75");
  });
});
