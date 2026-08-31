import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPdfRuntime, type PDFDocumentProxy } from "./pdfRuntime";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";

const calls = vi.hoisted(() => ({
  viewerDocument: vi.fn(),
  linkDocument: vi.fn(),
  findDocument: vi.fn(),
}));
vi.mock("pdfjs-dist/legacy/web/pdf_viewer.mjs", () => ({
  EventBus: class extends EventTarget {},
  LinkTarget: { BLANK: 2 },
  FindState: {},
  PDFViewer: class {
    setDocument = calls.viewerDocument;
  },
  PDFLinkService: class {
    setDocument = calls.linkDocument;
    setViewer = vi.fn();
  },
  PDFFindController: class {
    setDocument = calls.findDocument;
  },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "pdf.worker.mjs" }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("PDF runtime teardown", () => {
  it("skips removed or hidden layout and resumes when width or height recovers", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
    let resize = () => {};
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const container = {
      isConnected: true,
      clientWidth: 400,
      clientHeight: 600,
      getBoundingClientRect() {
        return { width: this.clientWidth, height: this.clientHeight };
      },
    };
    const viewerElement = { isConnected: true, offsetParent: {}, replaceChildren: vi.fn() };
    const onContainerResize = vi.fn();
    const runtime = createPdfRuntime({
      document: {} as PDFDocumentProxy,
      loadingTask: { destroy: vi.fn(async () => {}) } as unknown as PDFDocumentLoadingTask,
      sourceUrl: "http://localhost/paper.pdf",
      container: container as unknown as HTMLDivElement,
      viewerElement: viewerElement as unknown as HTMLDivElement,
      onContainerResize,
    });
    const settle = () => {
      for (let frame = 0; frame < 2; frame++) {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      }
    };
    runtime.refreshForContainerSize();
    viewerElement.isConnected = false;
    settle();
    expect(onContainerResize).not.toHaveBeenCalled();
    viewerElement.isConnected = true;
    container.clientHeight = 0;
    resize();
    settle();
    expect(onContainerResize).not.toHaveBeenCalled();
    container.clientHeight = 600;
    resize();
    settle();
    expect(onContainerResize).toHaveBeenCalledOnce();
    container.clientWidth = 0;
    resize();
    settle();
    expect(onContainerResize).toHaveBeenCalledOnce();
    container.clientWidth = 400;
    resize();
    settle();
    expect(onContainerResize).toHaveBeenCalledTimes(2);
    runtime.refreshForContainerSize();
    await runtime.destroy();
    settle();
    expect(onContainerResize).toHaveBeenCalledTimes(2);
  });

  it("detaches the viewer and services before destroying transport, exactly once", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const document = {} as PDFDocumentProxy;
    const destroy = vi.fn(async () => {
      expect(calls.viewerDocument).toHaveBeenLastCalledWith(null);
      expect(calls.linkDocument).toHaveBeenLastCalledWith(null);
      expect(calls.findDocument).toHaveBeenLastCalledWith(null);
      expect(disconnect).toHaveBeenCalledOnce();
    });
    const replaceChildren = vi.fn();
    const runtime = createPdfRuntime({
      document,
      loadingTask: { destroy } as unknown as PDFDocumentLoadingTask,
      sourceUrl: "http://localhost/paper.pdf",
      container: { getBoundingClientRect: () => ({ width: 400 }) } as HTMLDivElement,
      viewerElement: { replaceChildren } as unknown as HTMLDivElement,
    });
    expect(calls.viewerDocument).toHaveBeenCalledWith(document);
    await runtime.destroy();
    await runtime.destroy();
    runtime.refreshForContainerSize();
    expect(destroy).toHaveBeenCalledOnce();
    expect(replaceChildren).toHaveBeenCalledOnce();
    expect(calls.viewerDocument).toHaveBeenCalledTimes(2);
  });
});
