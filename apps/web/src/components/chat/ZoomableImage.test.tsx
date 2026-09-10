// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

const roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mountImage() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const ref = createRef<ZoomableImageHandle>();
  const onError = vi.fn();
  await act(() => {
    root.render(<ZoomableImage src="/fixture.png" name="Figure" ref={ref} onError={onError} />);
  });
  const viewport = host.querySelector<HTMLDivElement>('[role="region"]')!;
  const image = host.querySelector("img")!;
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

it("leaves gallery arrows available at fit and consumes them only when zoomed", async () => {
  const { viewport, ref, zoom, key } = await mountImage();
  expect(ref.current!.pan("ArrowRight")).toBe(false);
  expect(zoom()).toBe("100% zoom");

  expect((await key("Enter")).defaultPrevented).toBe(true);
  expect(zoom()).toBe("200% zoom");
  const left = viewport.scrollLeft;
  expect(ref.current!.pan("ArrowRight")).toBe(true);
  expect(viewport.scrollLeft).toBe(left + 40);
  expect(ref.current!.pan("Escape")).toBe(false);

  await key("0");
  expect(zoom()).toBe("100% zoom");
  expect(ref.current!.pan("ArrowRight")).toBe(false);
});

it("does not hijack modified shortcuts or repeatedly toggle on a held key", async () => {
  const { zoom, key } = await mountImage();
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
  const { viewport, zoom } = await mountImage();
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
  const { viewport, image, onError } = await mountImage();
  expect(viewport.getAttribute("aria-label")).toBe("Figure, zoomable image");
  expect(viewport.tabIndex).toBe(0);
  expect(image.alt).toBe("Figure");
  await act(() => image.dispatchEvent(new Event("error")));
  expect(onError).toHaveBeenCalledOnce();
});
