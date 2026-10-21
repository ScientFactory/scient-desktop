import { fakeTimers, stubGlobal as _fixtureStubGlobal } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  copyStaticImage,
  downloadStaticImage,
  staticImageCopyDimensions,
} from "./staticImageActions";

async function _cleanupFixture0(_fixture: _Fixture) {
  vi.unstubAllGlobals();
}

describe("static image copy dimensions", () => {
  it("preserves ordinary image dimensions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    expect(staticImageCopyDimensions(1_200, 800)).toEqual({ width: 1_200, height: 800 });
  });

  it("bounds extremely large images by dimension and pixel count", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const wide = staticImageCopyDimensions(20_000, 2_000);
    expect(wide.width).toBe(8_192);
    expect(wide.height).toBe(819);

    const square = staticImageCopyDimensions(10_000, 10_000);
    expect(square.width * square.height).toBeLessThanOrEqual(16_777_216);
    expect(square.width).toBe(square.height);
  });

  it("rejects absent and invalid intrinsic dimensions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    expect(() => staticImageCopyDimensions(0, 100)).toThrow(/usable dimensions/u);
    expect(() => staticImageCopyDimensions(Number.NaN, 100)).toThrow(/usable dimensions/u);
  });
});

describe("static image byte actions", () => {
  it("starts browser clipboard access before the fresh URL is available", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let resolveUrl!: (url: string) => void;
    const url = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => png });
    const write = vi.fn().mockResolvedValue(undefined);
    let clipboardPng: Blob | Promise<Blob> | undefined;
    function TestClipboardItem(data: Record<string, Blob | Promise<Blob>>) {
      clipboardPng = data["image/png"];
    }
    _fixture.stack.use(_fixtureStubGlobal("fetch", fetch));
    _fixture.stack.use(vi.spyOn(navigator.clipboard, "write").mockImplementation(write));
    _fixture.stack.use(_fixtureStubGlobal("ClipboardItem", TestClipboardItem));
    const pending = copyStaticImage(url);
    expect(write).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    resolveUrl("https://environment.test/api/assets/fresh");
    await pending;
    expect(await clipboardPng).toBe(png);
  });

  it("retains native desktop PNG clipboard support without browser ClipboardItem", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const copyPngToClipboard = vi.fn().mockResolvedValue(undefined);
    _fixture.stack.use(
      _fixtureStubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, blob: async () => source }),
      ),
    );
    _fixture.stack.use(_fixtureStubGlobal("desktopBridge", { copyPngToClipboard }));
    _fixture.stack.use(_fixtureStubGlobal("ClipboardItem", undefined));
    await copyStaticImage(Promise.resolve("https://environment.test/figure.png"));
    expect(copyPngToClipboard).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("handles simultaneous clipboard construction and image preparation failures", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.stack.use(vi.spyOn(navigator.clipboard, "write").mockResolvedValue(undefined));
    _fixture.stack.use(
      _fixtureStubGlobal("ClipboardItem", function () {
        throw new Error("Clipboard denied");
      }),
    );
    await expect(copyStaticImage(Promise.reject(new Error("Image unavailable")))).rejects.toThrow(
      "Clipboard denied",
    );
    // The rejected preparation remains observed even when the clipboard never consumes it.
    await Promise.resolve();
  });

  it("copies an existing PNG without re-encoding it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const write = vi.fn().mockResolvedValue(undefined);
    const items: Array<Record<string, Blob | Promise<Blob>>> = [];
    function TestClipboardItem(data: Record<string, Blob | Promise<Blob>>) {
      items.push(data);
    }
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => source });
    _fixture.stack.use(_fixtureStubGlobal("fetch", fetch));
    _fixture.stack.use(vi.spyOn(navigator.clipboard, "write").mockImplementation(write));
    _fixture.stack.use(_fixtureStubGlobal("ClipboardItem", TestClipboardItem));

    await copyStaticImage("https://environment.test/figure.png");

    expect(await items[0]?.["image/png"]).toBe(source);
    expect(write).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://environment.test/figure.png", {
      cache: "no-store",
      mode: "cors",
    });
  });

  it("decodes and rasterizes SVG before copying PNG clipboard bytes", async () => {
    await using _fixture = _createFixture();
    const source = new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="red"/></svg>',
      ],
      { type: "image/svg+xml" },
    );
    _fixture.stack.use(vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(source)));
    const drawImage = _fixture.stack.use(vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage"));
    const createObjectURL = _fixture.stack.use(vi.spyOn(URL, "createObjectURL"));
    const write = _fixture.stack.use(
      vi.spyOn(navigator.clipboard, "write").mockResolvedValue(undefined),
    );

    await copyStaticImage("https://environment.test/figure.svg");

    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, 600, 400);
    expect((drawImage.mock.calls[0]![0] as HTMLImageElement).src).toMatch(
      /^data:image\/svg\+xml[;,]/,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const png = await write.mock.calls[0]![0][0]!.getType("image/png");
    expect(png.type).toBe("image/png");
    const url = URL.createObjectURL(png);
    _fixture.stack.defer(() => URL.revokeObjectURL(url));
    const decoded = new Image();
    decoded.src = url;
    await decoded.decode();
    expect(decoded.naturalWidth).toBe(600);
    expect(decoded.naturalHeight).toBe(400);
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const context = canvas.getContext("2d")!;
    context.drawImage(decoded, 0, 0);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });

  it("downloads the unmodified original bytes with the artifact filename", async () => {
    await using _fixture = _createFixture();
    using _timers = fakeTimers();
    const source = new Blob(["<svg/>"], { type: "image/svg+xml" });
    _fixture.stack.use(vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(source)));
    const create = _fixture.stack.use(vi.spyOn(document, "createElement"));
    const append = _fixture.stack.use(vi.spyOn(document.body, "append"));
    const click = _fixture.stack.use(
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}),
    );
    const remove = _fixture.stack.use(vi.spyOn(Element.prototype, "remove"));
    const createObjectURL = _fixture.stack.use(vi.spyOn(URL, "createObjectURL"));
    const revokeObjectURL = _fixture.stack.use(vi.spyOn(URL, "revokeObjectURL"));

    await downloadStaticImage("https://environment.test/figure.svg", "figure.svg");

    const anchor = create.mock.results.find(
      (result) => result.type === "return" && result.value instanceof HTMLAnchorElement,
    )!.value as HTMLAnchorElement;
    const url = createObjectURL.mock.results[0]!.value;
    expect(createObjectURL).toHaveBeenCalledWith(source);
    expect(anchor.href).toBe(url);
    expect(anchor.download).toBe("figure.svg");
    expect(anchor.rel).toBe("noopener");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(anchor.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("rejects failed requests and non-image responses", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.stack.use(
      _fixtureStubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 })),
    );
    await expect(
      downloadStaticImage("https://environment.test/missing.png", "missing.png"),
    ).rejects.toThrow(/status 404/u);

    _fixture.stack.use(
      _fixtureStubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          blob: async () => new Blob(["not an image"], { type: "text/plain" }),
        }),
      ),
    );
    await expect(
      downloadStaticImage("https://environment.test/file.txt", "file.txt"),
    ).rejects.toThrow(/not an image/u);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
