import { page } from "vitest/browser";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useRef } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { LatexSourceResizeHandle } from "./LatexSourceResizeHandle";

describe("upward LaTeX source resizing", () => {
  const capture = vi.fn();
  const release = vi.fn();

  async function _setupFixture0(_fixture: _Fixture) {
    const previousViewport = { width: innerWidth, height: innerHeight };
    _fixture.stack.defer(() => page.viewport(previousViewport.width, previousViewport.height));
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
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
    await act(async () => await _fixture.root0.rerender(<Harness />));
    _fixture.field = _fixture.host.querySelector("textarea")!;
    _fixture.handle = _fixture.host.querySelector('[role="separator"]')!;
    _fixture.field.style.cssText =
      "position:fixed;bottom:calc(100vh - 500px);width:300px;block-size:100px;box-sizing:border-box";
    expect(_fixture.field.getBoundingClientRect().height).toBe(100);
    expect(_fixture.field.getBoundingClientRect().bottom).toBe(500);
    capture.mockReset();
    release.mockReset();
    Object.assign(_fixture.handle, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  const pointer = async (_fixture: _Fixture, type: string, y: number, id = 1) =>
    await act(() =>
      _fixture.handle.dispatchEvent(
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
  const key = async (_fixture: _Fixture, key: string) =>
    await act(() =>
      _fixture.handle.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      ),
    );

  it("grows upward while keeping the bottom and code fixed, then releases the gesture", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await pointer(_fixture, "pointerdown", 200);
    expect(capture).toHaveBeenCalledWith(1);
    await pointer(_fixture, "pointermove", 150);
    expect(_fixture.field.style.height).toBe("150px");
    expect(_fixture.field.getBoundingClientRect().bottom).toBe(500);
    expect(_fixture.field.value).toBe("x^2 + y^2");
    await pointer(_fixture, "pointerup", 140);
    expect(_fixture.field.style.height).toBe("160px");
    expect(release).toHaveBeenCalledWith(1);
    await pointer(_fixture, "pointermove", 50);
    expect(_fixture.field.style.height).toBe("160px");
  });

  it("supports keyboard resizing with minimum and maximum bounds", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(() => _fixture.handle.focus());
    expect(_fixture.handle.getAttribute("aria-valuenow")).toBe("100");
    await key(_fixture, "ArrowUp");
    expect(_fixture.field.style.height).toBe("120px");
    await key(_fixture, "ArrowDown");
    expect(_fixture.field.style.height).toBe("100px");
    await key(_fixture, "Home");
    expect(_fixture.field.style.height).toBe("64px");
    await key(_fixture, "ArrowDown");
    expect(_fixture.field.style.height).toBe("64px");
    await key(_fixture, "End");
    expect(_fixture.field.style.height).toBe("320px");
    expect(_fixture.handle.getAttribute("aria-valuenow")).toBe("320");
  });

  it("bounds growth by the visible viewport and ignores other pointers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await page.viewport(1280, 200);
    expect(visualViewport?.height).toBe(200);
    await pointer(_fixture, "pointerdown", 200);
    await pointer(_fixture, "pointermove", 100, 2);
    expect(_fixture.field.style.height).toBe("");
    await pointer(_fixture, "pointercancel", 100, 2);
    await pointer(_fixture, "pointermove", -200);
    expect(_fixture.field.style.height).toBe("120px");
    await pointer(_fixture, "pointercancel", -200);
    await pointer(_fixture, "pointermove", 220);
    expect(_fixture.field.style.height).toBe("120px");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    field: undefined! as HTMLTextAreaElement,
    handle: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
