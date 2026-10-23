import {
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
} from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { createPdfPresentationLayer, preparePdfPresentation } from "./pdfPresentation";
import type { ScientPdfRuntime } from "./pdfRuntime";

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());
  _fixture.frames = new Map();
  _fixture.nextFrame = 0;
  _fixture.stack.use(
    _fixtureStubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      _fixture.frames.set(++_fixture.nextFrame, callback);
      return _fixture.nextFrame;
    }),
  );
  _fixture.stack.use(
    _fixtureStubGlobal("cancelAnimationFrame", (id: number) => _fixture.frames.delete(id)),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  _clearOwnedDOM(_fixture);
}
async function frame(_fixture: _Fixture) {
  const work = [..._fixture.frames.values()];
  _fixture.frames.clear();
  work.forEach((callback) => callback(0));
  await Promise.resolve();
}
function fixture(_fixture: _Fixture) {
  const mount = document.createElement("div");
  mount.style.cssText = "position:relative;width:800px;height:600px";
  document.body.append(_ownDOM(_fixture, mount));
  const layer = createPdfPresentationLayer(mount);
  layer.container.style.cssText = "height:600px;overflow:auto";
  expect(layer.container.clientHeight).toBe(600);
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.style.height = "1000px";
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

it("keeps staging sized and inaccessible without removing the current surface", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const f = fixture(_fixture);
  expect(f.container.inert).toBe(true);
  expect(f.container.getAttribute("aria-hidden")).toBe("true");
  expect(f.container.classList.contains("scient-pdf-staging")).toBe(true);
  expect(f.container.style.display).not.toBe("none");
});
it("waits for actual canvas AND text-layer completion, then two stable frames", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const f = fixture(_fixture);
  let done = false;
  const controller = _fixture.abortController();
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    signal: controller.signal,
  }).then(() => {
    done = true;
  });
  await frame(_fixture);
  await frame(_fixture);
  expect(done).toBe(false);
  f.view.renderingState = 3;
  f.emit("pagerendered", { pageNumber: 1 });
  await frame(_fixture);
  await frame(_fixture);
  expect(done).toBe(false);
  f.emit("textlayerrendered", { pageNumber: 1 });
  await frame(_fixture);
  expect(done).toBe(false);
  await frame(_fixture);
  await promise;
  expect(done).toBe(true);
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
});
it("follows newer scroll and zoom rather than overwriting navigation with an old snapshot", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const f = fixture(_fixture);
  const live = fixture(_fixture);
  live.container.scrollTop = 90;
  const controller = _fixture.abortController();
  const promise = preparePdfPresentation({
    ...f,
    current: () => live,
    signal: controller.signal,
  });
  await frame(_fixture);
  expect(f.container.scrollTop).toBe(90);
  live.container.scrollTop = 160;
  live.viewer.currentScale = 1.3;
  await frame(_fixture);
  expect(f.container.scrollTop).toBe(160);
  expect(f.viewer.currentScale).toBe(1.3);
  f.view.renderingState = 3;
  f.emit("textlayerrendered", { pageNumber: 1 });
  await frame(_fixture);
  await frame(_fixture);
  await promise;
});
it("aborts obsolete work and releases all callbacks", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const f = fixture(_fixture);
  const controller = _fixture.abortController();
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    signal: controller.signal,
  });
  const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await assertion;
  expect(_fixture.frames.size).toBe(0);
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
});
it("rejects broken renders and bounds an indefinitely stalled replacement", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const f = fixture(_fixture);
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    signal: _fixture.abortController().signal,
  });
  const assertion = expect(promise).rejects.toThrow("not ready");
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(_fixture.frames.size).toBe(0);
});

it("rejects a failed canvas without admitting an unpainted presentation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const f = fixture(_fixture);
  const promise = preparePdfPresentation({
    ...f,
    current: () => null,
    signal: _fixture.abortController().signal,
  });
  const assertion = expect(promise).rejects.toThrow("page could not be rendered");
  f.emit("pagerendered", { pageNumber: 1, error: new Error("render failed") });
  await assertion;
  expect(_fixture.frames.size).toBe(0);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  return {
    abortController() {
      const controller = new AbortController();
      stack.defer(() => controller.abort());
      return controller;
    },
    get frames() {
      return frames;
    },
    set frames(value: Map<number, FrameRequestCallback>) {
      frames = value;
    },
    get nextFrame() {
      return nextFrame;
    },
    set nextFrame(value: number) {
      nextFrame = value;
    },

    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
