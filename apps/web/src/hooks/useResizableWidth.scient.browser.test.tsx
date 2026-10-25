import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

function Panel({
  edge = "left",
  maxWidth = 800,
  storageKey = "test-panel-width",
}: {
  edge?: "left" | "right";
  maxWidth?: number;
  storageKey?: string;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth: 400,
    minWidth: 200,
    maxWidth,
    edge,
  });
  return (
    <aside data-testid="host">
      <output>{width}</output>
      <div data-testid="handle" {...handlers} />
    </aside>
  );
}

async function renderPanel() {
  await using stack = new AsyncDisposableStack();
  let captured = false;
  let frame: FrameRequestCallback | undefined;
  const cancelAnimationFrame = vi.fn();
  stack.use(
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 42;
    }),
  );
  stack.use(vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelAnimationFrame));
  const setItem = stack.use(vi.spyOn(Storage.prototype, "setItem"));
  localStorage.clear();
  stack.defer(() => localStorage.clear());
  let screen: Screen = stack.use(await render(<Panel />));
  const container = () => screen.container;
  const host = () => container().querySelector<HTMLElement>("[data-testid=host]")!;

  function handle() {
    const element = container().querySelector<HTMLElement>("[data-testid=handle]")!;
    // Synthetic pointers have no active pointer for the browser to capture.
    element.setPointerCapture = () => {
      captured = true;
    };
    element.hasPointerCapture = () => captured;
    element.releasePointerCapture = () => {
      captured = false;
    };
    return element;
  }

  const environment = stack.move();
  return {
    setItem,
    cancelAnimationFrame,
    get captured() {
      return captured;
    },
    frame: () => frame?.(0),
    host,
    shownWidth: () => Number(container().querySelector("output")!.textContent),
    liveWidth: () => host().style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY),
    pointer(
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture",
      clientX = 100,
    ) {
      handle().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX,
        }),
      );
    },
    rerender: (element: ReactNode = <Panel />) => screen.rerender(element),
    unmount: () => screen.unmount(),
    async mountFresh(element: ReactNode = <Panel />) {
      screen = environment.use(await render(element));
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

const bodyStyle = () => document.body.style;

describe("panel resize cleanup", () => {
  // SCIENT-FORK:START — main's useResizeDrag.ts chooses ew-resize on Windows.
  // regression: a75a6d7643 test(web): misc-b tests run in a real browser (#20869)
  it.each(["unmount", "lost capture", "blur", "cancel"])(
    "clears the cursor and pending resize after %s",
    async (reason) => {
      await using panel = await renderPanel();
      const { pointer, host, shownWidth, liveWidth, setItem, cancelAnimationFrame } = panel;
      await act(() => {
        pointer("pointerdown");
        pointer("pointermove", 50);
      });
      const resizedHost = host();
      await act(() => panel.frame());
      expect(liveWidth()).toBe("450px");
      expect(resizedHost.style.getPropertyValue("transition-property")).toBe("none");
      expect(shownWidth()).toBe(400);
      await act(() => pointer("pointermove", 25));
      expect(bodyStyle().cursor).toBe(
        /^win/i.test(navigator.platform) ? "ew-resize" : "col-resize",
      );
      expect(bodyStyle().userSelect).toBe("none");
      if (reason === "unmount") await panel.unmount();
      await act(() => {
        if (reason === "lost capture") pointer("lostpointercapture");
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        if (reason === "cancel") pointer("pointercancel");
      });
      expect(bodyStyle().cursor).toBe("");
      expect(bodyStyle().userSelect).toBe("");
      expect(panel.captured).toBe(false);
      expect(resizedHost.style.getPropertyValue("transition-property")).toBe("");
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      if (reason === "unmount") {
        expect(setItem).not.toHaveBeenCalled();
        await panel.mountFresh();
      } else {
        expect(shownWidth()).toBe(475);
        expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
      }
    },
  );
  // SCIENT-FORK:END
});
