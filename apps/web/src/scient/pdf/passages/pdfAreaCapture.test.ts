// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ScientPdfRuntime } from "../pdfRuntime";
import { beginPdfAreaSelection } from "./pdfPassageCapture";
import { passageHash } from "./pdfPassageModel";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((clean) => clean());
  vi.unstubAllGlobals();
});
function fixture() {
  const bytes = new TextEncoder().encode("%PDF-1.7 fixture");
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      terminate() {}
      postMessage(input: Uint8Array) {
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("message", { data: passageHash(input) })),
        );
      }
    },
  );
  const page = document.createElement("div");
  document.body.append(page);
  cleanups.push(() => page.remove());
  Object.defineProperties(page, { clientWidth: { value: 600 }, clientHeight: { value: 800 } });
  const events = new Map<string, () => void>();
  const getTextContent = vi.fn();
  const pdf = {
    document: {
      getData: async () => bytes,
      getDownloadInfo: async () => ({ length: bytes.length }),
      getPermissions: async () => null,
      getTextContent,
    },
    viewer: {
      container: page,
      currentPageNumber: 1,
      getPageView: () => ({
        div: page,
        pdfPage: { view: [0, 0, 600, 800], rotate: 0, userUnit: 1 },
        viewport: {
          width: 600,
          height: 800,
          convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
        },
      }),
    },
    eventBus: {
      on: (name: string, fn: () => void) => events.set(name, fn),
      off: (name: string) => events.delete(name),
    },
  } as unknown as ScientPdfRuntime;
  const capture = vi.fn();
  const cancel = vi.fn();
  const error = vi.fn();
  const cleanup = beginPdfAreaSelection(pdf, capture, cancel, error);
  cleanups.push(cleanup);
  const overlay = page.querySelector<HTMLElement>('[role="application"]')!;
  Object.defineProperties(overlay, { clientWidth: { value: 600 }, clientHeight: { value: 800 } });
  return { page, overlay, capture, cancel, error, events, getTextContent };
}
it("captures native page geometry with no extraction or invented quotation, once", async () => {
  const f = fixture();
  f.overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  f.overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
  expect(f.capture.mock.calls[0]?.[0]).toMatchObject({
    profile: "pdf-native-area-v1",
    pages: [{ page: 1, rectangles: [[90, 560, 390, 680]] }],
  });
  expect(f.capture.mock.calls[0]?.[0].pages[0]).not.toHaveProperty("quote");
  expect(f.getTextContent).not.toHaveBeenCalled();
  expect(f.overlay.isConnected).toBe(false);
  expect(f.events.size).toBe(0);
});
it.each(["scalechanging", "rotationchanging", "scroll", "Escape"])(
  "cancels safely on %s",
  async (event) => {
    const f = fixture();
    if (event === "scroll") f.page.dispatchEvent(new Event("scroll"));
    else if (event === "Escape")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else f.events.get(event)!();
    f.overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.overlay.isConnected).toBe(false);
    expect(f.events.size).toBe(0);
  },
);
