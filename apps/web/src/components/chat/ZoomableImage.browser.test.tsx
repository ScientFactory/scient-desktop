import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { createRef } from "react";

import { expect, it, vi } from "vite-plus/test";

import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

async function _setupFixture0(_fixture: _Fixture) {}

async function _cleanupFixture1(_fixture: _Fixture) {
  for (const root of _fixture.root0.splice(0)) await act(async () => await root.unmount());
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

async function mountImage(_fixture: _Fixture) {
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  _fixture.root0.push(root);
  const ref = createRef<ZoomableImageHandle>();
  const onError = vi.fn();
  await act(async () => {
    await root.rerender(
      <ZoomableImage
        src={`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="black"/></svg>')}`}
        name="Figure"
        ref={ref}
        onError={onError}
      />,
    );
  });
  const viewport = host.querySelector<HTMLDivElement>('[role="region"]')!;
  const image = host.querySelector("img")!;
  await image.decode();
  await expect.poll(() => viewport.style.width).not.toBe("");
  host.style.setProperty("--media-width", viewport.style.width);
  const zoom = () => host.querySelector('[aria-live="polite"]')!.textContent;
  const key = async (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(() => viewport.dispatchEvent(event));
    return event;
  };
  return { viewport, image, ref, onError, zoom, key };
}

it("leaves gallery arrows available at fit and consumes them only when zoomed with overflow", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const { viewport, ref, zoom, key } = await mountImage(_fixture);
  expect(ref.current!.pan("ArrowRight")).toBe(false);
  expect(zoom()).toBe("100% zoom");

  expect((await key("Enter")).defaultPrevented).toBe(true);
  expect(zoom()).toBe("200% zoom");
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.offsetWidth);
  const left = viewport.scrollLeft;
  expect(ref.current!.pan("ArrowRight")).toBe(true);
  expect(viewport.scrollLeft).toBe(left + 40);
  expect(ref.current!.pan("Escape")).toBe(false);

  await key("0");
  expect(zoom()).toBe("100% zoom");
  expect(ref.current!.pan("ArrowRight")).toBe(false);
});

it("does not hijack modified shortcuts or repeatedly toggle on a held key", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const { zoom, key } = await mountImage(_fixture);
  expect((await key("+", { metaKey: true })).defaultPrevented).toBe(false);
  expect((await key("+", { ctrlKey: true })).defaultPrevented).toBe(false);
  expect(zoom()).toBe("100% zoom");
  await key(" ");
  await key(" ", { repeat: true });
  expect(zoom()).toBe("200% zoom");
  await key(" ");
  expect(zoom()).toBe("100% zoom");
});

it("bounds wheel zoom and returns to fit when the window resizes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const { viewport, zoom } = await mountImage(_fixture);
  const wheel = async (deltaY: number) => {
    const event = new WheelEvent("wheel", { deltaY, cancelable: true });
    await act(() => viewport.dispatchEvent(event));
    return event;
  };
  expect((await wheel(-100_000)).defaultPrevented).toBe(true);
  expect(zoom()).toBe("800% zoom");
  await wheel(100_000);
  expect(zoom()).toBe("100% zoom");
  await wheel(-100_000);
  await act(() => window.dispatchEvent(new Event("resize")));
  expect(zoom()).toBe("100% zoom");
});

it("retains the image label and delegates load failure to the existing dialog", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const { viewport, image, onError } = await mountImage(_fixture);
  expect(viewport.getAttribute("aria-label")).toBe("Figure, zoomable image");
  expect(viewport.tabIndex).toBe(0);
  expect(image.alt).toBe("Figure");
  await act(() => image.dispatchEvent(new Event("error")));
  expect(onError).toHaveBeenCalledOnce();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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
