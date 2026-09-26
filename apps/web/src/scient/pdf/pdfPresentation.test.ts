// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createPdfPresentationLayer, preparePdfPresentation } from "./pdfPresentation";
import type { ScientPdfRuntime } from "./pdfRuntime";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
async function frame() {
  const work = [...frames.values()];
  frames.clear();
  work.forEach((callback) => callback(0));
  await Promise.resolve();
}
function fixture() {
  const mount = document.createElement("div");
  document.body.append(mount);
  const layer = createPdfPresentationLayer(mount);
  Object.defineProperty(layer.container, "clientHeight", { value: 600 });
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  Object.defineProperties(page, { offsetTop: { value: 0 }, clientHeight: { value: 1000 } });
  layer.viewerElement.append(page);
  const listeners = new Map<string, Set<(event: any) => void>>();
  const view = { renderingState: 0, textLayer: {} };
  const viewer = {
    currentPageNumber: 1,
    currentScale: 1,
    pagesRotation: 0,
    update: vi.fn(),
    getPageView: () => view,
  };
  const runtime = {
    viewer,
    eventBus: {
      on: (name: string, listener: (event: any) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
      },
      off: (name: string, listener: (event: any) => void) => listeners.get(name)?.delete(listener),
    },
  } as unknown as ScientPdfRuntime;
  const emit = (name: string, event: object) => listeners.get(name)?.forEach((fn) => fn(event));
  return { ...layer, page, runtime, view, viewer, listeners, emit };
}

it("keeps staging sized and inaccessible without removing the current surface", () => {
  const f = fixture();
  expect(f.container.inert).toBe(true);
  expect(f.container.getAttribute("aria-hidden")).toBe("true");
  expect(f.container.classList.contains("scient-pdf-staging")).toBe(true);
  expect(f.container.style.display).not.toBe("none");
});
it("waits for actual canvas AND text-layer completion, then two stable frames", async () => {
  const f = fixture();
  let done = false;
  const controller = new AbortController();
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    captureAnchor: () => null,
    signal: controller.signal,
  }).then(() => {
    done = true;
  });
  await frame();
  await frame();
  expect(done).toBe(false);
  f.view.renderingState = 3;
  f.emit("pagerendered", { pageNumber: 1 });
  await frame();
  await frame();
  expect(done).toBe(false);
  f.emit("textlayerrendered", { pageNumber: 1 });
  await frame();
  expect(done).toBe(false);
  await frame();
  await promise;
  expect(done).toBe(true);
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
});
it("follows newer scroll and zoom rather than overwriting navigation with an old snapshot", async () => {
  const f = fixture(),
    live = fixture();
  live.container.scrollTop = 90;
  const controller = new AbortController();
  const promise = preparePdfPresentation({
    ...f,
    current: () => live,
    captureAnchor: () => null,
    signal: controller.signal,
  });
  await frame();
  expect(f.container.scrollTop).toBe(90);
  live.container.scrollTop = 160;
  live.viewer.currentScale = 1.3;
  await frame();
  expect(f.container.scrollTop).toBe(160);
  expect(f.viewer.currentScale).toBe(1.3);
  f.view.renderingState = 3;
  f.emit("textlayerrendered", { pageNumber: 1 });
  await frame();
  await frame();
  await promise;
});
it("compensates source-anchor displacement before publishing, without touching the live viewport", async () => {
  const f = fixture(),
    live = fixture();
  live.container.scrollTop = 80;
  f.view.renderingState = 3;
  const promise = preparePdfPresentation({
    ...f,
    current: () => live,
    captureAnchor: () => ({ key: "source-position", screenTop: 100, locate: () => 140 }),
    signal: new AbortController().signal,
  });
  f.emit("textlayerrendered", { pageNumber: 1 });
  await frame();
  expect(f.container.scrollTop).toBe(120);
  expect(live.container.scrollTop).toBe(80);
  await frame();
  await promise;
});
it("aborts obsolete work and releases all callbacks", async () => {
  const f = fixture(),
    controller = new AbortController();
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    captureAnchor: () => null,
    signal: controller.signal,
  });
  const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await assertion;
  expect(frames.size).toBe(0);
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
});
it("rejects broken renders and bounds an indefinitely stalled replacement", async () => {
  const f = fixture();
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    captureAnchor: () => null,
    signal: new AbortController().signal,
  });
  const assertion = expect(promise).rejects.toThrow("not ready");
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(frames.size).toBe(0);
});

it("does not publish during asynchronous reflow lookup or follow a superseded anchor", async () => {
  const f = fixture();
  f.view.renderingState = 3;
  const controller = new AbortController();
  let key = "older-source";
  const lookups: ((page: number | null) => void)[] = [];
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    signal: controller.signal,
    captureAnchor: () => ({
      key,
      screenTop: 100,
      locate: () => null,
      locatePage: () => new Promise((resolve) => lookups.push(resolve)),
    }),
  });
  const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  f.emit("textlayerrendered", { pageNumber: 1 });
  await frame();
  expect(lookups.length).toBe(1);
  key = "newer-source";
  await frame();
  expect(lookups.length).toBe(2);
  lookups[0]!(2);
  await Promise.resolve();
  expect(f.viewer.currentPageNumber).toBe(1);
  controller.abort();
  await assertion;
  lookups[1]!(3);
  await Promise.resolve();
  expect(f.viewer.currentPageNumber).toBe(1);
});

it("rejects a failed canvas without admitting an unpainted presentation", async () => {
  const f = fixture();
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    captureAnchor: () => null,
    signal: new AbortController().signal,
  });
  const assertion = expect(promise).rejects.toThrow("page could not be rendered");
  f.emit("pagerendered", { pageNumber: 1, error: new Error("render failed") });
  await assertion;
  expect(frames.size).toBe(0);
});
