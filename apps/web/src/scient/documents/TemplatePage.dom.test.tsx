// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TemplatePage } from "./TemplatePage";
import { templatePicture } from "./templatePreviews";

describe("small template page framing", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const picture = templatePicture("article", null)!;
  const pixels = (bounds: { left: number; top: number; right: number; bottom: number }) => {
    const data = new Uint8ClampedArray(160 * 226 * 4).fill(255);
    const ink = (x: number, y: number) => {
      const offset = (y * 160 + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 158;
    };
    for (let y = bounds.top; y < bounds.bottom; y++)
      for (let x = bounds.left; x < bounds.right; x++) ink(x, y);
    ink(80, 215); // The page number does not pull sparse content down.
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      getImageData: () => ({ data }),
    } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
    return drawImage;
  };
  const load = async () => {
    const image = host.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 160 });
    Object.defineProperty(image, "naturalHeight", { value: 226 });
    await act(() => image.dispatchEvent(new Event("load")));
    return image;
  };

  it.each([
    { left: 20, top: 70, right: 100, bottom: 110 },
    { left: 20, top: 20, right: 150, bottom: 200 },
  ])("keeps the title centered and the whole content visible: %o", async (content) => {
    pixels(content);
    await act(() => root.render(<TemplatePage picture={picture} width={164} cropped />));
    const image = await load();
    const pageWidth = parseFloat(image.style.width);
    const pageHeight = pageWidth * Math.SQRT2;
    const left = parseFloat(image.style.left) + (content.left / 160) * pageWidth;
    const right = parseFloat(image.style.left) + (content.right / 160) * pageWidth;
    const top = parseFloat(image.style.top) + (content.top / 226) * pageHeight;
    const bottom = parseFloat(image.style.top) + (content.bottom / 226) * pageHeight;
    // A title centered on the original page stays centered even when body lines are shorter.
    expect(parseFloat(image.style.left) + pageWidth / 2).toBeCloseTo(82);
    expect((top + bottom) / 2).toBeCloseTo((164 * Math.SQRT2) / 2);
    expect(left).toBeGreaterThanOrEqual(8 - 0.001);
    expect(right).toBeLessThanOrEqual(164 - 8 + 0.001);
    expect(top).toBeGreaterThanOrEqual(8 - 0.001);
    expect(bottom).toBeLessThanOrEqual(164 * Math.SQRT2 - 8 + 0.001);
  });

  it("restores the original full page and skips thumbnail measurements when expanded", async () => {
    const drawImage = pixels({ left: 20, top: 70, right: 100, bottom: 110 });
    await act(() => root.render(<TemplatePage picture={picture} width={164} cropped />));
    await load();
    await act(() => root.render(<TemplatePage picture={picture} width={632} />));
    const image = host.querySelector("img")!;
    expect(image.style.width).toBe("632px");
    expect(image.style.left).toBe("0px");
    expect(image.style.top).toBe("0px");
    if (picture.kind === "image") expect(image.getAttribute("src")).toBe(picture.expandedSrc);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it("keeps a readable crop if image pixels cannot be inspected", async () => {
    pixels({ left: 20, top: 70, right: 100, bottom: 110 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await act(() => root.render(<TemplatePage picture={picture} width={164} cropped />));
    const before = host.querySelector("img")!.getAttribute("style");
    const image = await load();
    expect(image.getAttribute("style")).toBe(before);
  });

  it("keeps a captured page's horizontal axis and centers its content vertically", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 408, 528),
    );
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      new DOMRect(40, 80, 80, 60),
    ] as unknown as DOMRectList);
    const captured = templatePicture(
      null,
      '<div data-page-width="816" data-page-height="1056"><p style="text-align:left">My notes</p></div>',
    )!;
    await act(() => root.render(<TemplatePage picture={captured} width={164} cropped />));
    const page = host.querySelector<HTMLDivElement>(".origin-top-left")!;
    const scale = Number(page.style.transform.match(/scale\(([^)]+)\)/u)![1]);
    expect(parseFloat(page.style.left) + 408 * scale).toBeCloseTo(82);
    expect(parseFloat(page.style.top) + 220 * scale).toBeCloseTo((164 * 1056) / 816 / 2);
    expect(page.querySelector("p")!.style.textAlign).toBe("left");
    await act(() => root.render(<TemplatePage picture={captured} width={632} />));
    expect(page.style.left).toBe("0px");
    expect(page.style.top).toBe("0px");
    expect(page.querySelector("p")!.style.textAlign).toBe("left");
    expect(page.closest("[inert]")).not.toBeNull();
  });
});
