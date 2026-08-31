import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ScientPdfRuntime } from "../pdfRuntime";
import {
  captureSelectedPdfPassage,
  readPassageMaterial,
  readPdfPassageSelection,
  showCapturedPdfPassage,
  verifyCapturedPdfPassage,
} from "./pdfPassageCapture";
import { capturePdfPassage, passageHash, type PassageSelection } from "./pdfPassageModel";

const bytes = new TextEncoder().encode("fixture bytes");
const workers: PassageWorker[] = [];
class PassageWorker extends EventTarget {
  terminate = vi.fn();
  postMessage = vi.fn((input: Uint8Array, _transfer: Transferable[]) => {
    queueMicrotask(() =>
      this.dispatchEvent(new MessageEvent("message", { data: passageHash(input) })),
    );
  });
  constructor() {
    super();
    workers.push(this);
  }
}
beforeEach(() => {
  workers.length = 0;
  vi.stubGlobal("Worker", PassageWorker);
});
const selection: PassageSelection = {
  page: 1,
  text: "Exact selected words\n",
  start: 6,
  end: 14,
  viewBox: [0, 0, 600, 800],
  rotation: 0,
  userUnit: 1,
  rectangles: [[20, 600, 100, 620]],
};
function runtime(overrides: Record<string, unknown> = {}) {
  return {
    document: {
      getDownloadInfo: vi.fn(async () => ({ length: bytes.length })),
      getData: vi.fn(async () => bytes),
      getPermissions: vi.fn(async () => null),
      numPages: 1,
      getPage: vi.fn(async () => ({
        view: [0, 0, 600, 800],
        rotate: 0,
        userUnit: 1,
        getTextContent: vi.fn(async () => ({
          items: [{ str: "Exact selected words", hasEOL: true }],
        })),
      })),
      ...overrides,
    },
  } as unknown as ScientPdfRuntime;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PDF passage runtime adapter", () => {
  it("shares one worker across concurrent reads, transfers the buffer, hashes only the byte view and terminates", async () => {
    const backing = new TextEncoder().encode("unrelated-fixture-bytes-trailing");
    const view = backing.subarray(10, 23);
    const pdf = runtime({ getData: vi.fn(async () => view) });
    const results = await Promise.all(Array.from({ length: 32 }, () => readPassageMaterial(pdf)));
    expect(new Set(results.map((result) => result.sha256))).toEqual(new Set([passageHash(view)]));
    expect(results[0]?.byteLength).toBe(view.byteLength);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.postMessage).toHaveBeenCalledWith(view, [view.buffer]);
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(pdf.document.getData).toHaveBeenCalledOnce();
  });

  it("refuses missing worker support before buffering without a synchronous fallback", async () => {
    vi.stubGlobal("Worker", undefined);
    const pdf = runtime();
    await expect(readPassageMaterial(pdf)).rejects.toThrow("worker support");
    expect(pdf.document.getData).not.toHaveBeenCalled();
  });

  it("retries a failed worker, terminates it, and checks actual byte length as well as metadata", async () => {
    vi.stubGlobal(
      "Worker",
      class extends PassageWorker {
        override postMessage = vi.fn(() => {
          queueMicrotask(() => this.dispatchEvent(new Event("error", { cancelable: true })));
        });
      },
    );
    const pdf = runtime();
    await expect(readPassageMaterial(pdf)).rejects.toThrow("worker failed");
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    vi.stubGlobal("Worker", PassageWorker);
    expect((await readPassageMaterial(pdf)).sha256).toBe(passageHash(bytes));
    expect(workers).toHaveLength(2);
    const large = runtime({ getData: async () => new Uint8Array(100 * 1024 * 1024 + 1) });
    await expect(readPassageMaterial(large)).rejects.toThrow("100 MB");
    expect(workers).toHaveLength(2);
  });

  it.each(["invalid-message", "message-error", "post-error"])(
    "terminates on %s",
    async (failure) => {
      vi.stubGlobal(
        "Worker",
        class extends PassageWorker {
          override postMessage = vi.fn(() => {
            if (failure === "post-error") throw new Error("post failed");
            queueMicrotask(() =>
              failure === "message-error"
                ? this.dispatchEvent(new Event("messageerror"))
                : this.dispatchEvent(new MessageEvent("message", { data: "not a hash" })),
            );
          });
        },
      );
      await expect(readPassageMaterial(runtime())).rejects.toThrow();
      expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    },
  );

  it("uses loaded bytes, shares only material hashes within one runtime, and checks extraction", async () => {
    const pdf = runtime();
    const result = await captureSelectedPdfPassage(pdf, [selection]);
    expect(result._tag).toBe("Captured");
    if (result._tag !== "Captured") return;
    expect(result.capture.pages[0]?.quote).toBe("selected");
    expect(await verifyCapturedPdfPassage(pdf, result.capture)).toEqual({ _tag: "Exact" });
    expect(pdf.document.getData).toHaveBeenCalledTimes(1);
    const reopened = runtime();
    expect(await verifyCapturedPdfPassage(reopened, result.capture)).toEqual({ _tag: "Exact" });
    expect(reopened.document.getData).toHaveBeenCalledTimes(1);
  });

  it("refuses a text layer which does not match raw PDF.js extraction", async () => {
    expect(
      await captureSelectedPdfPassage(runtime(), [{ ...selection, text: "Other words" }]),
    ).toEqual({ _tag: "Refused", reason: "page-text-changed" });
  });

  it("does not read bytes for an empty selection", async () => {
    const pdf = runtime();
    expect(await captureSelectedPdfPassage(pdf, [])).toEqual({
      _tag: "Refused",
      reason: "empty-selection",
    });
    expect(pdf.document.getData).not.toHaveBeenCalled();
  });

  it("bounds buffering and honors PDF copy restrictions", async () => {
    const large = runtime({ getDownloadInfo: async () => ({ length: 101 * 1024 * 1024 }) });
    await expect(readPassageMaterial(large)).rejects.toThrow("100 MB");
    expect(large.document.getData).not.toHaveBeenCalled();
    const restricted = runtime({ getPermissions: async () => [] });
    await expect(readPassageMaterial(restricted)).rejects.toThrow("does not permit copying");
    expect(restricted.document.getData).not.toHaveBeenCalled();
  });

  it("allows retry after a failed material read", async () => {
    const getData = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(bytes);
    const pdf = runtime({ getData });
    await expect(readPassageMaterial(pdf)).rejects.toThrow("network");
    expect(await readPassageMaterial(pdf)).toEqual({
      sha256: passageHash(bytes),
      byteLength: bytes.length,
    });
    expect(getData).toHaveBeenCalledTimes(2);
  });

  it("never reads matching-looking page text after the material changed", async () => {
    const first = await captureSelectedPdfPassage(runtime(), [selection]);
    if (first._tag !== "Captured") throw new Error("fixture capture failed");
    const changed = runtime({ getData: async () => new TextEncoder().encode("different PDF") });
    const before = JSON.stringify(first.capture);
    expect(await verifyCapturedPdfPassage(changed, first.capture)).toEqual({
      _tag: "NotExact",
      reason: "material-changed",
    });
    expect(changed.document.getPage).not.toHaveBeenCalled();
    expect(JSON.stringify(first.capture)).toBe(before);
  });

  it("uses supported point conversions, repaints after viewport changes, and cleans every marker", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.set(++nextFrame, fn);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const markers: Array<{
      style: { cssText: string };
      remove: ReturnType<typeof vi.fn>;
      setAttribute: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const marker = { style: { cssText: "" }, remove: vi.fn(), setAttribute: vi.fn() };
        markers.push(marker);
        return marker;
      },
    });
    const events = new Map<string, () => void>();
    const viewport = {
      width: 600,
      height: 800,
      convertToViewportPoint: vi.fn((x: number, y: number) => [x, 800 - y]),
    };
    const div = {
      clientLeft: 0,
      clientTop: 0,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
      append: vi.fn(),
    };
    const pdf = {
      viewer: {
        getPageView: () => ({
          viewport,
          div,
          textLayer: {
            div: {
              isConnected: true,
              getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 800 }),
            },
          },
        }),
        scrollPageIntoView: vi.fn(),
      },
      eventBus: {
        on: (event: string, fn: () => void) => events.set(event, fn),
        off: (event: string) => events.delete(event),
      },
    } as unknown as ScientPdfRuntime;
    const captured = capturePdfPassage({
      material: { sha256: passageHash(bytes), byteLength: bytes.length },
      extractorVersion: "6.2.108",
      selection: [selection],
    });
    if (captured._tag !== "Captured") throw new Error("fixture capture failed");
    const clean = showCapturedPdfPassage(pdf, captured.capture);
    const flush = () => {
      const work = [...frames.values()];
      frames.clear();
      for (const callback of work) callback(0);
    };
    flush();
    expect(markers[0]?.style.cssText).toContain("left:20px;top:180px;width:80px;height:20px");
    expect(viewport.convertToViewportPoint).toHaveBeenCalledTimes(2);
    events.get("rotationchanging")!();
    flush();
    expect(markers[0]?.remove).toHaveBeenCalledOnce();
    expect(markers).toHaveLength(2);
    events.get("scalechanging")!();
    clean();
    expect(markers[1]?.remove).toHaveBeenCalledOnce();
    expect(events.size).toBe(0);
    expect(frames.size).toBe(0);
  });
});

// Narrow DOM seam fixture. Actual browser ranges/rotation are separately exercised
// in the integrated reader; these regressions verify bounded work and refusal reasons.
function selectionFixture(
  options: {
    text?: string;
    angle?: string;
    pages?: number;
    rectangles?: number;
    hidden?: boolean;
    nodes?: number;
  } = {},
) {
  class ElementFixture {
    dataset = { pageNumber: "1" };
    parentElement = this;
    isConnected = true;
    hidden = options.hidden ?? false;
    ownerDocument = {
      createTreeWalker: () => {
        let remaining = options.nodes ?? 1;
        return { nextNode: () => remaining-- > 0, currentNode: textNode };
      },
      createRange: () => ({ setStart: vi.fn(), setEnd: vi.fn(), getClientRects }),
    };
    closest(selector: string) {
      return selector === ".endOfContent" ? null : this;
    }
    contains() {
      return true;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 600, height: 800 };
    }
  }
  const layer = new ElementFixture();
  const endLayer = new ElementFixture();
  endLayer.dataset.pageNumber = String(options.pages ?? 1);
  const textNode = {
    nodeType: 3,
    textContent: options.text ?? "Exact selected words",
    parentElement: layer,
  };
  const endNode = options.pages ? { ...textNode, parentElement: endLayer } : textNode;
  const getClientRects = vi.fn(() =>
    Array.from({ length: options.rectangles ?? 1 }, (_, index) => ({
      left: 10 + index,
      right: 30 + index,
      top: 20,
      bottom: 40,
      width: 20,
      height: 20,
    })),
  );
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal(
    "HTMLBRElement",
    class {
      nodeType = 1;
    },
  );
  vi.stubGlobal("Node", { TEXT_NODE: 3 });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4, SHOW_ELEMENT: 1 });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => options.angle ?? "0" }));
  const range = {
    startContainer: textNode,
    endContainer: endNode,
    startOffset: 0,
    endOffset: textNode.textContent.length,
    intersectsNode: () => true,
    comparePoint: () => 0,
  };
  const pdf = {
    viewer: {
      viewer: layer,
      getPageView: vi.fn(() => ({
        textLayer: { div: layer },
        pdfPage: { view: [0, 0, 600, 800], rotate: 0, userUnit: 1 },
        viewport: {
          width: 600,
          height: 800,
          convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
        },
      })),
    },
  } as unknown as ScientPdfRuntime;
  const selected = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
  } as unknown as Selection;
  return { pdf, selected, getClientRects };
}

describe("PDF selection limits and geometry", () => {
  it("distinguishes no selection from a refused selection", () => {
    const fixture = selectionFixture();
    expect(readPdfPassageSelection(fixture.pdf, null)).toEqual({ _tag: "Empty" });
  });

  it.each(["0", "90deg", "-90deg", "180deg", "270deg"])(
    "accepts axis-aligned text at %s",
    (angle) => {
      const fixture = selectionFixture({ angle });
      expect(readPdfPassageSelection(fixture.pdf, fixture.selected)._tag).toBe("Ready");
    },
  );

  it.each(["35deg", "-35deg", "45deg", "NaN"])(
    "refuses unsupported angle %s before collecting misleading rectangles",
    (angle) => {
      const fixture = selectionFixture({ angle });
      expect(readPdfPassageSelection(fixture.pdf, fixture.selected)).toEqual({
        _tag: "Refused",
        reason: "unsupported-text-angle",
      });
      expect(fixture.getClientRects).not.toHaveBeenCalled();
    },
  );

  it("refuses five pages before visiting their text layers", () => {
    const fixture = selectionFixture({ pages: 5 });
    expect(readPdfPassageSelection(fixture.pdf, fixture.selected)).toEqual({
      _tag: "Refused",
      reason: "too-many-pages",
    });
    expect(fixture.pdf.viewer.getPageView).not.toHaveBeenCalled();
  });

  it.each([
    [{ text: "x".repeat(8001) }, "selection-too-large"],
    [{ text: "x".repeat(250001) }, "page-too-complex"],
    [{ nodes: 50001, text: "" }, "page-too-complex"],
    [{ hidden: true }, "page-not-ready"],
  ] as const)(
    "rejects oversized or unrendered selections before collecting geometry",
    (options, reason) => {
      const fixture = selectionFixture(options);
      expect(readPdfPassageSelection(fixture.pdf, fixture.selected)).toEqual({
        _tag: "Refused",
        reason,
      });
      expect(fixture.getClientRects).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 8000 characters and bounds geometry collection", () => {
    const atLimit = selectionFixture({ text: "x".repeat(8000), rectangles: 256 });
    expect(readPdfPassageSelection(atLimit.pdf, atLimit.selected)._tag).toBe("Ready");
    const above = selectionFixture({ rectangles: 257 });
    expect(readPdfPassageSelection(above.pdf, above.selected)).toEqual({
      _tag: "Refused",
      reason: "too-many-rectangles",
    });
  });
});
