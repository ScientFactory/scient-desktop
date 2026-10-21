import { describe, expect, it, vi } from "vite-plus/test";
import { observeLatexHeaderFit } from "./observeLatexHeaderFit";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
const steps = ["first", "second", "third"];

describe("responsive LaTeX header fitting", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.styles = document.createElement("style");
    _fixture.styles.textContent = `
      .test-header-fit { display:flex; white-space:nowrap; overflow:hidden; width:200px; height:28px; font:16px monospace; }
      .test-header-fit > span { flex:0 0 auto; }
      .test-header-fit .required { min-width:100px; }
      .test-header-fit .optional { width:60px; }
      .test-header-fit[data-fit~="first"] .first,
      .test-header-fit[data-fit~="second"] .second,
      .test-header-fit[data-fit~="third"] .third { display:none; }
    `;
    document.head.append(_fixture.styles);
    _fixture.row = document.createElement("div");
    _fixture.row.className = "test-header-fit";
    _fixture.required = document.createElement("span");
    _fixture.required.className = "required";
    _fixture.required.textContent = "Controls";
    _fixture.row.append(_fixture.required);
    for (const step of steps) {
      const control = document.createElement("span");
      control.className = `optional ${step}`;
      control.textContent = step;
      _fixture.row.append(control);
    }
    document.body.append(_fixture.row);
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    _fixture.dispose?.();
    _fixture.dispose = undefined;
    _fixture.row.remove();
    _fixture.styles.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }

  it("does not read geometry at installation and preserves ordered compaction on resize", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const reads = vi.spyOn(_fixture.row, "scrollWidth", "get");
    const clientReads = vi.spyOn(_fixture.row, "clientWidth", "get");
    _fixture.dispose = observeLatexHeaderFit(_fixture.row, steps);
    expect(reads).not.toHaveBeenCalled();
    expect(clientReads).not.toHaveBeenCalled();
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second");
    expect(_fixture.row.scrollWidth).toBeLessThanOrEqual(_fixture.row.clientWidth + 1);
    _fixture.row.style.width = "120px";
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second third");
    _fixture.row.style.width = "300px";
    await expect.poll(() => _fixture.row.dataset.fit).toBe("");
  });

  it("coalesces content changes and restores controls when the content shrinks", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.dispose = observeLatexHeaderFit(_fixture.row, steps);
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second");
    await settle();
    const reads = vi.spyOn(_fixture.row, "scrollWidth", "get");
    for (let i = 0; i < 20; i++) _fixture.required.textContent = "Long status message " + i;
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second third");
    await settle();
    expect(reads).toHaveBeenCalledTimes(3);
    _fixture.required.textContent = "OK";
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second");
  });

  it("keeps the last fit while hidden and cancels queued measurements on cleanup", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.dispose = observeLatexHeaderFit(_fixture.row, steps);
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second");
    _fixture.row.style.display = "none";
    await settle();
    expect(_fixture.row.dataset.fit).toBe("first second");
    _fixture.row.style.width = "300px";
    _fixture.row.style.display = "flex";
    await expect.poll(() => _fixture.row.dataset.fit).toBe("");
    await settle();
    const reads = vi.spyOn(_fixture.row, "scrollWidth", "get");
    _fixture.required.textContent = "Queued status update";
    await Promise.resolve();
    _fixture.dispose();
    _fixture.dispose = undefined;
    _fixture.row.style.width = "120px";
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).not.toHaveBeenCalled();
    expect(_fixture.row.dataset.fit).toBe("");
  });

  it("finishes without animation frames and cancels a detached initial fit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(2147483000);
    _fixture.dispose = observeLatexHeaderFit(_fixture.row, steps);
    await expect.poll(() => _fixture.row.dataset.fit).toBe("first second");
    _fixture.dispose();
    _fixture.dispose = undefined;
    _fixture.row.dataset.fit = "";
    const reads = vi.spyOn(_fixture.row, "scrollWidth", "get");
    observeLatexHeaderFit(_fixture.row, steps)();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).not.toHaveBeenCalled();
    expect(_fixture.row.dataset.fit).toBe("");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    dispose: undefined! as (() => void) | undefined,

    row: undefined! as HTMLDivElement,
    required: undefined! as HTMLSpanElement,
    styles: undefined! as HTMLStyleElement,
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
