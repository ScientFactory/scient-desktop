import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { observeLatexCurrentPage } from "./observeLatexCurrentPage";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

describe("Visual current-page observation", () => {
  let scroll: HTMLDivElement;
  let paper: HTMLDivElement;
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    scroll = document.createElement("div");
    scroll.style.cssText = "width:300px;height:300px;overflow:auto";
    paper = document.createElement("div");
    paper.className = "scient-latex-visual-paper";
    paper.style.cssText = "margin-top:40px;height:3000px";
    scroll.append(paper);
    document.body.append(scroll);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    scroll.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defers initial geometry and tracks scrolled pages at the current zoom", async () => {
    scroll.scrollTop = 700;
    const paperReads = vi.spyOn(paper, "getBoundingClientRect");
    const scrollReads = vi.spyOn(scroll, "getBoundingClientRect");
    const pages: number[] = [];
    dispose = observeLatexCurrentPage(
      scroll,
      { pageCount: 5, pageHeight: 400, pageGap: 20, zoom: 1.25 },
      (page) => pages.push(page),
    );
    expect(paperReads).not.toHaveBeenCalled();
    expect(scrollReads).not.toHaveBeenCalled();
    expect(pages).toEqual([]);
    await expect.poll(() => pages.at(-1)).toBe(2);
    scroll.scrollTop = 1500;
    await expect.poll(() => pages.at(-1)).toBe(3);
    dispose();
    dispose = observeLatexCurrentPage(
      scroll,
      { pageCount: 5, pageHeight: 400, pageGap: 20, zoom: 0.5 },
      (page) => pages.push(page),
    );
    await expect.poll(() => pages.at(-1)).toBe(5);
  });

  it("coalesces scroll notifications and cancels pending reads on disposal", async () => {
    const pages = vi.fn();
    const reads = vi.spyOn(paper, "getBoundingClientRect");
    dispose = observeLatexCurrentPage(
      scroll,
      { pageCount: 8, pageHeight: 400, pageGap: 20, zoom: 1 },
      pages,
    );
    await expect.poll(() => pages).toHaveBeenCalledWith(1);
    await settle();
    reads.mockClear();
    scroll.scrollTop = 1000;
    for (let i = 0; i < 20; i++) scroll.dispatchEvent(new Event("scroll"));
    await expect.poll(() => pages).toHaveBeenCalledWith(3);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    scroll.dispatchEvent(new Event("scroll"));
    dispose();
    dispose = undefined;
    await settle();
    expect(reads).not.toHaveBeenCalled();
    scroll.scrollTop = 2000;
    await settle();
    expect(reads).not.toHaveBeenCalled();
  });

  it("settles without animation frames and cancels an unmounted initial observation", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const pages = vi.fn();
    const dimensions = { pageCount: 8, pageHeight: 400, pageGap: 20, zoom: 1 };
    dispose = observeLatexCurrentPage(scroll, dimensions, pages);
    await expect.poll(() => pages).toHaveBeenCalledWith(1);
    dispose();
    dispose = undefined;
    const cancelled = vi.fn();
    observeLatexCurrentPage(scroll, dimensions, cancelled)();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cancelled).not.toHaveBeenCalled();
  });
});
