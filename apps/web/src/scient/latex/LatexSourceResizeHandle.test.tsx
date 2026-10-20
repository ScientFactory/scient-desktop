// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LatexSourceResizeHandle } from "./LatexSourceResizeHandle";

describe("upward LaTeX source resizing", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let field: HTMLTextAreaElement;
  let handle: HTMLDivElement;
  const capture = vi.fn();
  const release = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    function Harness() {
      const target = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <LatexSourceResizeHandle
            field={target}
            onResize={(height) => {
              if (target.current) target.current.style.height = `${height}px`;
            }}
          />
          <textarea ref={target} defaultValue="x^2 + y^2" />
        </>
      );
    }
    await act(() => root.render(<Harness />));
    field = host.querySelector("textarea")!;
    handle = host.querySelector('[role="separator"]')!;
    vi.spyOn(field, "getBoundingClientRect").mockImplementation(() => {
      const height = Number.parseFloat(field.style.height) || 100;
      return new DOMRect(0, 500 - height, 300, height);
    });
    capture.mockReset();
    release.mockReset();
    Object.assign(handle, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const pointer = (type: string, y: number, id = 1) =>
    act(() =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          isPrimary: true,
          button: 0,
          clientY: y,
        }),
      ),
    );
  const key = (key: string) =>
    act(() =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    );

  it("grows upward while keeping the bottom and code fixed, then releases the gesture", async () => {
    await pointer("pointerdown", 200);
    expect(capture).toHaveBeenCalledWith(1);
    await pointer("pointermove", 150);
    expect(field.style.height).toBe("150px");
    expect(field.getBoundingClientRect().bottom).toBe(500);
    expect(field.value).toBe("x^2 + y^2");
    await pointer("pointerup", 140);
    expect(field.style.height).toBe("160px");
    expect(release).toHaveBeenCalledWith(1);
    await pointer("pointermove", 50);
    expect(field.style.height).toBe("160px");
  });

  it("supports keyboard resizing with minimum and maximum bounds", async () => {
    await act(() => handle.focus());
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
    await key("ArrowUp");
    expect(field.style.height).toBe("120px");
    await key("ArrowDown");
    expect(field.style.height).toBe("100px");
    await key("Home");
    expect(field.style.height).toBe("64px");
    await key("ArrowDown");
    expect(field.style.height).toBe("64px");
    await key("End");
    expect(field.style.height).toBe("320px");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
  });

  it("bounds growth by the visible viewport and ignores other pointers", async () => {
    vi.stubGlobal("visualViewport", { height: 200, offsetTop: 100 });
    await pointer("pointerdown", 200);
    await pointer("pointermove", 100, 2);
    expect(field.style.height).toBe("");
    await pointer("pointercancel", 100, 2);
    await pointer("pointermove", -200);
    expect(field.style.height).toBe("120px");
    await pointer("pointercancel", -200);
    await pointer("pointermove", 220);
    expect(field.style.height).toBe("120px");
  });
});
