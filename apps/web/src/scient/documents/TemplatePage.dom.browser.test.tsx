import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { TemplatePage } from "./TemplatePage";
import { templatePicture } from "./templatePreviews";

describe("small template page framing", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }

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
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 226;
    canvas.getContext("2d")!.putImageData(new ImageData(data, 160, 226), 0, 0);
    const src = canvas.toDataURL("image/png");
    if (picture.kind !== "image") throw new Error("Expected a built-in raster thumbnail");
    return {
      picture: { ...picture, src, expandedSrc: `${src}#expanded` },
      drawImage: vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage"),
    };
  };
  const load = async (_fixture: _Fixture) => {
    const image = _fixture.host.querySelector("img")!;
    await image.decode();
    expect(image.naturalWidth).toBe(160);
    expect(image.naturalHeight).toBe(226);
    await act(() => {});
    return image;
  };

  it.each([
    { left: 20, top: 70, right: 100, bottom: 110 },
    { left: 20, top: 20, right: 150, bottom: 200 },
  ])("keeps the title centered and the whole content visible: %o", async (content) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { picture } = pixels(content);
    await act(
      async () =>
        await _fixture.root0.rerender(<TemplatePage picture={picture} width={164} cropped />),
    );
    const image = await load(_fixture);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { picture, drawImage } = pixels({ left: 20, top: 70, right: 100, bottom: 110 });
    await act(
      async () =>
        await _fixture.root0.rerender(<TemplatePage picture={picture} width={164} cropped />),
    );
    await load(_fixture);
    await act(
      async () => await _fixture.root0.rerender(<TemplatePage picture={picture} width={632} />),
    );
    const image = _fixture.host.querySelector("img")!;
    expect(image.style.width).toBe("632px");
    expect(image.style.left).toBe("0px");
    expect(image.style.top).toBe("0px");
    if (picture.kind === "image") expect(image.getAttribute("src")).toBe(picture.expandedSrc);
    await load(_fixture);
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it("keeps a readable crop if image pixels cannot be inspected", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { picture } = pixels({ left: 20, top: 70, right: 100, bottom: 110 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await act(
      async () =>
        await _fixture.root0.rerender(<TemplatePage picture={picture} width={164} cropped />),
    );
    const before = _fixture.host.querySelector("img")!.getAttribute("style");
    const image = await load(_fixture);
    expect(image.getAttribute("style")).toBe(before);
  });

  it("keeps a captured page's horizontal axis and centers its content vertically", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const captured = templatePicture(
      null,
      '<div data-page-width="816" data-page-height="1056"><p style="text-align:left">My notes</p></div>',
    )!;
    await act(
      async () =>
        await _fixture.root0.rerender(<TemplatePage picture={captured} width={164} cropped />),
    );
    const page = _fixture.host.querySelector<HTMLDivElement>(".origin-top-left")!;
    const scale = Number(page.style.transform.match(/scale\(([^)]+)\)/u)![1]);
    expect(parseFloat(page.style.left) + 408 * scale).toBeCloseTo(82);
    const content = document.createRange();
    content.selectNodeContents(page.querySelector("p")!);
    const contentRect = content.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    expect(contentRect.width).toBeGreaterThan(0);
    expect(
      parseFloat(page.style.top) + contentRect.top - pageRect.top + contentRect.height / 2,
    ).toBeCloseTo((164 * 1056) / 816 / 2, 1);
    expect(page.querySelector("p")!.style.textAlign).toBe("left");
    await act(
      async () => await _fixture.root0.rerender(<TemplatePage picture={captured} width={632} />),
    );
    expect(page.style.left).toBe("0px");
    expect(page.style.top).toBe("0px");
    expect(page.querySelector("p")!.style.textAlign).toBe("left");
    expect(page.closest("[inert]")).not.toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
