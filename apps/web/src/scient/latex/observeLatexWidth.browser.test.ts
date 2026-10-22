import { fakeTimers, stubGlobal as _fixtureStubGlobal } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { observeResize } from "~/lib/observeResize";
import { observeLatexWidth } from "./observeLatexWidth";

async function resizeDelivered(element: HTMLElement, change: () => void) {
  let deliver!: () => void;
  const delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const stop = observeResize(element, deliver);
  try {
    change();
    await delivered;
  } finally {
    stop();
  }
}
const nativeClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!.get!;

describe("observed LaTeX layout width", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.panel = document.createElement("div");
    _fixture.panel.style.cssText =
      "box-sizing:border-box;width:420.5px;height:80px;padding:7.25px;border:3px solid black;overflow:auto;scrollbar-gutter:stable";
    const content = document.createElement("div");
    content.style.height = "200px";
    _fixture.panel.append(content);
    document.body.append(_fixture.panel);
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    _fixture.dispose?.();
    _fixture.dispose = undefined;
    _fixture.panel.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }

  it("matches client width across padding, borders, scrolling and transforms without geometry reads", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const reads = vi.spyOn(_fixture.panel, "clientWidth", "get");
    const widths: number[] = [];
    _fixture.dispose = observeLatexWidth(_fixture.panel, (width) => widths.push(width));
    expect(widths).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(_fixture.panel));
    _fixture.panel.style.width = "267.5px";
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(_fixture.panel));
    _fixture.panel.style.transform = "scale(0.6)";
    _fixture.panel.style.paddingInline = "13.5px";
    _fixture.panel.style.width = "330.5px";
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(_fixture.panel));
    expect(_fixture.panel.getBoundingClientRect().width).toBeLessThan(widths.at(-1)!);
    expect(reads).not.toHaveBeenCalled();
  });

  it("retains the last useful width while hidden and disconnects on cleanup", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const widths: number[] = [];
    _fixture.dispose = observeLatexWidth(_fixture.panel, (width) => widths.push(width));
    await expect.poll(() => widths.length).toBe(1);
    await resizeDelivered(_fixture.panel, () => {
      _fixture.panel.style.display = "none";
    });
    expect(widths.length).toBe(1);
    _fixture.panel.style.width = "275px";
    _fixture.panel.style.display = "block";
    await expect.poll(() => widths.at(-1)).toBe(nativeClientWidth.call(_fixture.panel));
    const count = widths.length;
    _fixture.dispose();
    _fixture.dispose = undefined;
    await resizeDelivered(_fixture.panel, () => {
      _fixture.panel.style.width = "350px";
    });
    expect(widths.length).toBe(count);
  });

  it("defers and cancels the compatibility measurement when ResizeObserver is unavailable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureStubGlobal("ResizeObserver", undefined));
    using _timers = fakeTimers();
    const reads = vi.spyOn(_fixture.panel, "clientWidth", "get");
    const widths: number[] = [];
    _fixture.dispose = observeLatexWidth(_fixture.panel, (width) => widths.push(width));
    expect(reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(48);
    expect(widths.at(-1)).toBe(nativeClientWidth.call(_fixture.panel));
    expect(reads).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    observeLatexWidth(_fixture.panel, cancelled)();
    await vi.advanceTimersByTimeAsync(48);
    expect(cancelled).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    dispose: undefined! as (() => void) | undefined,

    panel: undefined! as HTMLDivElement,
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
