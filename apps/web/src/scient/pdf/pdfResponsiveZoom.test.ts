import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPdfResponsiveZoomController,
  type PdfResponsiveZoomTarget,
} from "./pdfResponsiveZoom";

function createTarget(initialScale: number, scaleValue = String(initialScale)) {
  let currentScale = initialScale;
  let currentScaleValue = scaleValue;
  let pageWidth = 800;
  let scaleWrites = 0;
  let scaleValueWrites = 0;
  const target: PdfResponsiveZoomTarget = {
    currentPageNumber: 1,
    get currentScale() {
      return currentScale;
    },
    set currentScale(value) {
      currentScale = value;
      currentScaleValue = String(value);
      scaleWrites += 1;
    },
    get currentScaleValue() {
      return currentScaleValue;
    },
    set currentScaleValue(value) {
      currentScaleValue = value;
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) currentScale = numeric;
      else if (value === "page-actual") currentScale = 1;
      scaleValueWrites += 1;
    },
    getPageView: () => ({ width: pageWidth * currentScale, scale: currentScale }),
    update: vi.fn(),
  };
  return {
    target,
    setPageWidth: (width: number) => {
      pageWidth = width;
    },
    scaleWrites: () => scaleWrites,
    scaleValueWrites: () => scaleValueWrites,
  };
}

describe("responsive PDF zoom", () => {
  it("temporarily shrinks a manual zoom and restores the exact preference", () => {
    const controller = createPdfResponsiveZoomController();
    const { target } = createTarget(1.25);
    controller.capturePreference(target);

    controller.reconcile(target, 600);
    expect(target.currentScale).toBeCloseTo(0.7);
    expect(controller.isConstrained()).toBe(true);
    expect(controller.persistedScaleValue()).toBe("1.25");

    controller.reconcile(target, 1_050);
    expect(target.currentScale).toBe(1.25);
    expect(controller.isConstrained()).toBe(false);
    expect(controller.persistedScaleValue()).toBe("1.25");
  });

  it("coalesces at the existing minimum without forgetting the preferred zoom", () => {
    const controller = createPdfResponsiveZoomController();
    const { target, scaleWrites } = createTarget(1);
    controller.capturePreference(target);

    controller.reconcile(target, 100);
    controller.reconcile(target, 100);

    expect(target.currentScale).toBe(0.25);
    expect(scaleWrites()).toBe(1);
    expect(controller.persistedScaleValue()).toBe("1");
  });

  it("keeps adaptive modes responsive instead of turning them into percentages", () => {
    const controller = createPdfResponsiveZoomController();
    const { target, scaleValueWrites } = createTarget(0.8, "page-width");
    controller.capturePreference(target);

    controller.reconcile(target, 420);
    controller.reconcile(target, 900);

    expect(target.currentScaleValue).toBe("page-width");
    expect(scaleValueWrites()).toBe(2);
    expect(controller.isConstrained()).toBe(false);
    expect(controller.persistedScaleValue()).toBe("page-width");
  });

  it("lets an explicit zoom replace a temporary resize preference", () => {
    const controller = createPdfResponsiveZoomController();
    const { target } = createTarget(1.5);
    controller.capturePreference(target);
    controller.reconcile(target, 600);
    expect(controller.isConstrained()).toBe(true);

    const manualScale = controller.rememberScale(0.55);
    target.currentScale = manualScale;
    controller.observeScaleChange(target, manualScale);

    expect(target.currentScale).toBe(0.55);
    expect(controller.isConstrained()).toBe(false);
    expect(controller.persistedScaleValue()).toBe("0.55");
  });

  it("does not treat fixed manual zoom as an adaptive page mode", () => {
    const controller = createPdfResponsiveZoomController();
    const { target } = createTarget(1.25);
    controller.capturePreference(target);
    controller.reconcile(target, 600);

    const manualScale = controller.rememberScale(0.75);
    target.currentScale = manualScale;
    controller.reconcile(target, 700);

    expect(target.currentScale).toBe(0.75);
    expect(controller.isConstrained()).toBe(false);
    expect(controller.persistedScaleValue()).toBe("0.75");
  });

  it("reconciles fixed zoom when the current page geometry changes", () => {
    const controller = createPdfResponsiveZoomController();
    const { target, setPageWidth } = createTarget(1.25);
    controller.capturePreference(target);

    controller.reconcile(target, 1_100);
    expect(target.currentScale).toBe(1.25);

    setPageWidth(1_200);
    controller.reconcile(target, 1_100);
    expect(target.currentScale).toBeCloseTo(1_060 / 1_200);
    expect(controller.isConstrained()).toBe(true);
    expect(controller.persistedScaleValue()).toBe("1.25");

    setPageWidth(800);
    controller.reconcile(target, 1_100);
    expect(target.currentScale).toBe(1.25);
    expect(controller.isConstrained()).toBe(false);
    expect(controller.persistedScaleValue()).toBe("1.25");
  });

  it("ignores synchronous PDF.js events raised by an internal reconciliation", () => {
    const controller = createPdfResponsiveZoomController();
    let currentScale = 1.25;
    let currentScaleValue = "1.25";
    let scaleWrites = 0;
    const target: PdfResponsiveZoomTarget = {
      currentPageNumber: 1,
      get currentScale() {
        return currentScale;
      },
      set currentScale(value) {
        currentScale = value;
        currentScaleValue = String(value);
        scaleWrites += 1;
        controller.observeScaleChange(target, value);
        controller.reconcile(target, 600);
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

    expect(scaleWrites).toBe(1);
    expect(target.currentScale).toBeCloseTo(0.7);
    expect(controller.isConstrained()).toBe(true);
    expect(controller.persistedScaleValue()).toBe("1.25");
  });

  it("restores Actual size as a named preference after temporary fitting", () => {
    const controller = createPdfResponsiveZoomController();
    const { target } = createTarget(1, "page-actual");
    controller.capturePreference(target);

    controller.reconcile(target, 600);
    expect(controller.isConstrained()).toBe(true);
    expect(target.currentScaleValue).not.toBe("page-actual");

    controller.reconcile(target, 900);
    expect(controller.isConstrained()).toBe(false);
    expect(target.currentScaleValue).toBe("page-actual");
    expect(controller.persistedScaleValue()).toBe("page-actual");
  });

  it("ignores transient responsive scale events but accepts external scale changes", () => {
    const controller = createPdfResponsiveZoomController();
    const { target } = createTarget(1.25);
    controller.capturePreference(target);
    controller.reconcile(target, 600);
    expect(controller.persistedScaleValue()).toBe("1.25");

    target.currentScaleValue = "0.9";
    controller.observeScaleChange(target, 0.9);

    expect(controller.persistedScaleValue()).toBe("0.9");
    expect(controller.isConstrained()).toBe(false);
  });

  it("does not drift under a long resize storm", () => {
    const controller = createPdfResponsiveZoomController();
    const { target } = createTarget(1.4);
    controller.capturePreference(target);

    for (let index = 0; index < 5_000; index += 1) {
      controller.reconcile(target, 220 + (index % 700));
    }
    controller.reconcile(target, 1_200);

    expect(target.currentScale).toBe(1.4);
    expect(controller.isConstrained()).toBe(false);
    expect(controller.persistedScaleValue()).toBe("1.4");
  });
});
