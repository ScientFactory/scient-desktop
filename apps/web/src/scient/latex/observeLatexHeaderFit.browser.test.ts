import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { observeLatexHeaderFit } from "./observeLatexHeaderFit";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
const steps = ["first", "second", "third"];

describe("responsive LaTeX header fitting", () => {
  let row: HTMLDivElement;
  let required: HTMLSpanElement;
  let styles: HTMLStyleElement;
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    styles = document.createElement("style");
    styles.textContent = `
      .test-header-fit { display:flex; white-space:nowrap; overflow:hidden; width:200px; height:28px; font:16px monospace; }
      .test-header-fit > span { flex:0 0 auto; }
      .test-header-fit .required { min-width:100px; }
      .test-header-fit .optional { width:60px; }
      .test-header-fit[data-fit~="first"] .first,
      .test-header-fit[data-fit~="second"] .second,
      .test-header-fit[data-fit~="third"] .third { display:none; }
    `;
    document.head.append(styles);
    row = document.createElement("div");
    row.className = "test-header-fit";
    required = document.createElement("span");
    required.className = "required";
    required.textContent = "Controls";
    row.append(required);
    for (const step of steps) {
      const control = document.createElement("span");
      control.className = `optional ${step}`;
      control.textContent = step;
      row.append(control);
    }
    document.body.append(row);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    row.remove();
    styles.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not read geometry at installation and preserves ordered compaction on resize", async () => {
    const reads = vi.spyOn(row, "scrollWidth", "get");
    const clientReads = vi.spyOn(row, "clientWidth", "get");
    dispose = observeLatexHeaderFit(row, steps);
    expect(reads).not.toHaveBeenCalled();
    expect(clientReads).not.toHaveBeenCalled();
    await expect.poll(() => row.dataset.fit).toBe("first second");
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    row.style.width = "120px";
    await expect.poll(() => row.dataset.fit).toBe("first second third");
    row.style.width = "300px";
    await expect.poll(() => row.dataset.fit).toBe("");
  });

  it("coalesces content changes and restores controls when the content shrinks", async () => {
    dispose = observeLatexHeaderFit(row, steps);
    await expect.poll(() => row.dataset.fit).toBe("first second");
    await settle();
    const reads = vi.spyOn(row, "scrollWidth", "get");
    for (let i = 0; i < 20; i++) required.textContent = "Long status message " + i;
    await expect.poll(() => row.dataset.fit).toBe("first second third");
    await settle();
    expect(reads).toHaveBeenCalledTimes(3);
    required.textContent = "OK";
    await expect.poll(() => row.dataset.fit).toBe("first second");
  });

  it("keeps the last fit while hidden and cancels queued measurements on cleanup", async () => {
    dispose = observeLatexHeaderFit(row, steps);
    await expect.poll(() => row.dataset.fit).toBe("first second");
    row.style.display = "none";
    await settle();
    expect(row.dataset.fit).toBe("first second");
    row.style.width = "300px";
    row.style.display = "flex";
    await expect.poll(() => row.dataset.fit).toBe("");
    await settle();
    const reads = vi.spyOn(row, "scrollWidth", "get");
    required.textContent = "Queued status update";
    await Promise.resolve();
    dispose();
    dispose = undefined;
    row.style.width = "120px";
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).not.toHaveBeenCalled();
    expect(row.dataset.fit).toBe("");
  });

  it("finishes without animation frames and cancels a detached initial fit", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(2147483000);
    dispose = observeLatexHeaderFit(row, steps);
    await expect.poll(() => row.dataset.fit).toBe("first second");
    dispose();
    dispose = undefined;
    row.dataset.fit = "";
    const reads = vi.spyOn(row, "scrollWidth", "get");
    observeLatexHeaderFit(row, steps)();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).not.toHaveBeenCalled();
    expect(row.dataset.fit).toBe("");
  });
});
