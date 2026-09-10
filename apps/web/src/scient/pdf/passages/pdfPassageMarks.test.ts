// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ScientPassageCapture } from "@scientfactory/scient-sources";
import type { ScientPdfRuntime } from "../pdfRuntime";
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "test",
  PermissionFlag: { COPY: 16 },
}));
import { showCapturedPdfPassage } from "./pdfPassageCapture";

const capture: ScientPassageCapture = {
  material: { sha256: "a".repeat(64), byteLength: 100 },
  extractorVersion: "test",
  profile: "pdfjs-text-layer-utf16-eol-v1",
  pages: [
    {
      page: 1,
      viewBox: [0, 0, 600, 800],
      rotation: 0,
      userUnit: 1,
      start: 0,
      end: 5,
      quote: "Quote",
      prefix: "",
      suffix: "",
      pageTextHash: "b".repeat(64),
      rectangles: [[30, 20, 90, 40]],
    },
  ],
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup() {
  vi.useFakeTimers();
  const page = document.createElement("div");
  const layer = document.createElement("div");
  page.append(layer);
  document.body.append(page);
  let scale = 1;
  vi.spyOn(page, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 600 * scale, 800 * scale),
  );
  vi.spyOn(layer, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 600 * scale, 800 * scale),
  );
  const events = new Map<string, () => void>();
  const scroll = vi.fn();
  const runtime = {
    viewer: {
      scrollPageIntoView: scroll,
      getPageView: () => ({
        div: page,
        textLayer: { div: layer },
        viewport: {
          width: 600 * scale,
          height: 800 * scale,
          convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
        },
      }),
    },
    eventBus: {
      on: (event: string, fn: () => void) => events.set(event, fn),
      off: (event: string) => events.delete(event),
    },
  } as unknown as ScientPdfRuntime;
  return {
    runtime,
    page,
    events,
    scroll,
    zoom: () => {
      scale = 2;
      events.get("scalechanging")!();
      vi.runAllTimers();
    },
  };
}

describe("PDF annotation marks", () => {
  it("does not fill note-only text and places its indicator at the page edge", () => {
    const state = setup();
    const clean = showCapturedPdfPassage(state.runtime, capture, {
      navigate: false,
      highlighted: false,
      onActivate: vi.fn(),
    });
    vi.runAllTimers();
    const marker = state.page.querySelector<HTMLElement>(".scient-pdf-passage-proof-mark")!;
    const button = state.page.querySelector("button")!;
    expect(marker.style.background).toBe("transparent");
    expect(marker.style.outlineStyle).toBe("none");
    expect(button.style.left).toBe("");
    expect(button.style.right).toBe("3px");
    expect(button.dataset.revealed).toBeUndefined();
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 20, 60, 20));
    state.page.dispatchEvent(new PointerEvent("pointermove", { clientX: 40, clientY: 30 }));
    expect(button.dataset.revealed).toBe("true");
    state.page.dispatchEvent(new PointerEvent("pointerleave"));
    expect(button.dataset.revealed).toBeUndefined();
    clean();
  });

  it("paints clickable marks without navigation, and cleans up every marker and listener", () => {
    const state = setup();
    const activate = vi.fn();
    const clean = showCapturedPdfPassage(state.runtime, capture, {
      navigate: false,
      onActivate: activate,
    });
    vi.runAllTimers();
    expect(state.scroll).not.toHaveBeenCalled();
    expect(state.page.querySelectorAll(".scient-pdf-passage-proof-mark")).toHaveLength(1);
    state.page.querySelector("button")!.click();
    expect(activate).toHaveBeenCalledTimes(1);
    clean();
    expect(state.page.querySelector("button")).toBeNull();
    expect(state.page.querySelector(".scient-pdf-passage-proof-mark")).toBeNull();
    expect(state.events.size).toBe(0);
    state.page.dispatchEvent(new MouseEvent("click", { clientX: 40, clientY: 30 }));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("repaints in zoomed coordinates without accumulating duplicates", () => {
    const state = setup();
    const clean = showCapturedPdfPassage(state.runtime, capture, {
      navigate: false,
      onActivate: vi.fn(),
    });
    vi.runAllTimers();
    expect(
      state.page.querySelector<HTMLElement>(".scient-pdf-passage-proof-mark")!.style.left,
    ).toBe("30px");
    for (let index = 0; index < 100; index++) state.zoom();
    expect(
      state.page.querySelector<HTMLElement>(".scient-pdf-passage-proof-mark")!.style.left,
    ).toBe("60px");
    expect(state.page.querySelectorAll(".scient-pdf-passage-proof-mark")).toHaveLength(1);
    expect(state.page.querySelectorAll("button")).toHaveLength(1);
    clean();
  });

  it("does not open an annotation while text is selected", () => {
    const state = setup();
    const activate = vi.fn();
    const clean = showCapturedPdfPassage(state.runtime, capture, {
      navigate: false,
      onActivate: activate,
    });
    vi.runAllTimers();
    const marker = state.page.querySelector<HTMLElement>(".scient-pdf-passage-proof-mark")!;
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 20, 60, 20));
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false } as Selection);
    state.page.dispatchEvent(new MouseEvent("click", { clientX: 40, clientY: 30 }));
    expect(activate).not.toHaveBeenCalled();
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: true } as Selection);
    state.page.dispatchEvent(new MouseEvent("click", { clientX: 40, clientY: 30 }));
    expect(activate).toHaveBeenCalledTimes(1);
    clean();
  });
});
