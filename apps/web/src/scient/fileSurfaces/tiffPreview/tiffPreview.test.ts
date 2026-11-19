// @effect-diagnostics nodeBuiltinImport:off -- Node's Zstandard encoder builds the test blocks.
import * as NodeZlib from "node:zlib";

import { fromArrayBuffer, GeoTIFFImage } from "geotiff";
import { describe, expect, it, vi } from "vite-plus/test";

import { tiffFixture, type TiffFixturePage } from "../../../../test/tiffFixture";
import {
  decodeLzw,
  inflateBounded,
  JPEG_TILE_BYTES,
  jpegFrameSize,
  jpegTileWorkingBytes,
  jpegWorkingBytes,
  registerBoundedTiffDecoders,
  zstdContentSize,
} from "./tiffBlockDecoders";
import { readTiffPlane, type TiffPreviewInfo } from "./tiffPreview";
import { tiffAxisSteps } from "./tiffPreviewText";
import { openTiffBytes } from "./tiffSource";

// Records typed-array allocations above `limit` elements and refuses them instead of allocating.
function watchAllocations(name: "Uint8Array" | "Uint16Array", limit: number) {
  const large: number[] = [];
  const Real = globalThis[name];
  vi.stubGlobal(
    name,
    new Proxy(Real, {
      construct(target, args: unknown[]) {
        if (typeof args[0] === "number" && args[0] > limit) {
          large.push(args[0]);
          throw new RangeError("large test allocation");
        }
        return Reflect.construct(target, args) as object;
      },
    }),
  );
  return { large, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

// Packs unsigned samples most-significant bit first, as TIFF stores widths that are not whole bytes.
function packSamples(values: readonly number[], bits: number) {
  const out = new Uint8Array(Math.ceil((values.length * bits) / 8));
  let bit = 0;
  for (const value of values)
    for (let index = bits - 1; index >= 0; index--, bit++)
      if (Math.floor(value / 2 ** index) % 2) out[bit >> 3]! |= 0x80 >> (bit & 7);
  return out;
}

registerBoundedTiffDecoders();

const gray = (width: number, height: number, value: (x: number, y: number) => number) =>
  Array.from({ length: width * height }, (_, index) =>
    value(index % width, Math.floor(index / width)),
  );

async function plane(
  pages: readonly TiffFixturePage[],
  options: { plane?: number; bigTiff?: boolean; maxOutputPixels?: number } = {},
) {
  // The app's range reader, so the layout check knows the file size.
  const tiff = await openTiffBytes(await tiffFixture(pages, { bigTiff: options.bigTiff ?? false }));
  return readTiffPlane(tiff, {
    plane: options.plane ?? 0,
    ...(options.maxOutputPixels ? { maxOutputPixels: options.maxOutputPixels } : {}),
  });
}

// The toolbar's plane text: one position per named axis, or the page number.
function tiffPlaneLabel(info: TiffPreviewInfo) {
  const steps = tiffAxisSteps(info.plane, info.axes);
  if (!steps.length) return `Page ${info.plane + 1} of ${info.planes}`;
  return steps.map((step) => `${step.name} ${step.index + 1}/${step.size}`).join(" · ");
}

const red = (rgba: Uint8ClampedArray, pixel: number) => rgba[pixel * 4]!;
const mean = (rgba: Uint8ClampedArray) => {
  let sum = 0;
  for (let index = 0; index < rgba.length; index += 4) sum += rgba[index]!;
  return sum / (rgba.length / 4);
};

describe("readTiffPlane", () => {
  it("stretches 12-bit data stored in 16 bits instead of scaling it to near black", async () => {
    const data = gray(64, 64, (x, y) => 100 + ((x + y * 64) % 3_996));
    const result = await plane([{ width: 64, height: 64, bits: 16, data }]);
    expect(result.info.range).toEqual([100, 4_095]);
    expect(result.info.display![0]).toBeGreaterThanOrEqual(100);
    expect(result.info.display![1]).toBeLessThanOrEqual(4_095);
    expect(mean(result.rgba)).toBeGreaterThan(100);
    // The old fixed /257 mapping of the same data.
    expect(data.reduce((sum, value) => sum + value / 257, 0) / data.length).toBeLessThan(10);
  });

  it("keeps NaN pixels transparent and reports the finite float range", async () => {
    const data = gray(8, 8, (x, y) => (x === 0 && y === 0 ? Number.NaN : (x - 4) / 2));
    const result = await plane([{ width: 8, height: 8, bits: 32, format: 3, data }]);
    expect(result.info.format).toBe("float");
    expect(result.info.range).toEqual([-2, 1.5]);
    expect(result.rgba[3]).toBe(0);
    expect(result.rgba[7]).toBe(255);
  });

  it("orders signed 16-bit values below zero before positive ones", async () => {
    const data = gray(4, 1, (x) => [-1_000, -10, 10, 1_000][x]!);
    const result = await plane([{ width: 4, height: 1, bits: 16, format: 2, data }]);
    expect(result.info.range).toEqual([-1_000, 1_000]);
    const shades = [0, 1, 2, 3].map((pixel) => red(result.rgba, pixel));
    expect(shades[0]).toBeLessThan(shades[1]!);
    expect(shades[1]).toBeLessThan(shades[2]!);
    expect(shades[2]).toBeLessThan(shades[3]!);
  });

  it("shows the requested page of a plain multi-page file and clamps past the end", async () => {
    const pages = [10, 20, 30].map((value) => ({
      width: 2,
      height: 2,
      bits: 16 as const,
      data: [value, value, value, value + 1],
    }));
    const second = await plane(pages, { plane: 1 });
    expect(second.info).toMatchObject({ plane: 1, planes: 3, range: [20, 21] });
    expect(tiffPlaneLabel(second.info)).toBe("Page 2 of 3");
    expect((await plane(pages, { plane: 99 })).info).toMatchObject({ plane: 2, range: [30, 31] });
  });

  it("labels ImageJ hyperstacks by channel and slice and keeps a single channel's display range", async () => {
    const description = "ImageJ=1.54f\nimages=4\nchannels=2\nslices=2\nhyperstack=true\n";
    const pages = [0, 1, 2, 3].map((index) => ({
      width: 2,
      height: 1,
      bits: 16 as const,
      data: [index * 100, index * 100 + 1],
      ...(index === 0 ? { description } : {}),
    }));
    const third = await plane(pages, { plane: 2 });
    expect(tiffPlaneLabel(third.info)).toBe("C 1/2 · Z 2/2");
    expect(third.info.channel).toBe(0);
    expect(third.info.display).not.toEqual([0, 4_095]);

    const single = await plane([
      {
        width: 2,
        height: 1,
        bits: 16,
        data: [0, 4_000],
        description: "ImageJ=1.54f\nmin=0.0\nmax=4095.0\n",
      },
    ]);
    expect(single.info.display).toEqual([0, 4_095]);

    const missing = await plane([{ ...pages[0]!, description: "ImageJ=1.54f\nimages=9\n" }]);
    expect(missing.info.planes).toBe(1);
  });

  it("maps OME planes in XYZCT order", async () => {
    const description =
      '<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" SizeX="1" SizeY="1" SizeZ="2" SizeC="3" SizeT="2"><Channel ID="Channel:0:0" SamplesPerPixel="1"/></Pixels></Image></OME>';
    const pages = Array.from({ length: 12 }, (_, index) => ({
      width: 1,
      height: 1,
      bits: 16 as const,
      data: [index],
      ...(index === 0 ? { description } : {}),
    }));
    const result = await plane(pages, { plane: 7 });
    expect(result.info.planes).toBe(12);
    // Z is fastest, then C, then T: plane 7 is z=1, c=0, t=1.
    expect(tiffPlaneLabel(result.info)).toBe("C 1/3 · Z 2/2 · T 2/2");
    expect(result.info.range).toEqual([7, 7]);
  });

  it("does not count reduced-resolution images as pages", async () => {
    const page = { width: 2, height: 2, bits: 8 as const, data: [1, 2, 3, 4] };
    const result = await plane([
      page,
      { ...page, width: 1, height: 1, data: [1], subfileType: 1 },
      page,
    ]);
    expect(result.info.planes).toBe(2);
  });

  it("reads BigTIFF", async () => {
    const result = await plane([{ width: 2, height: 1, bits: 16, data: [5, 900] }], {
      bigTiff: true,
    });
    expect(result.info.range).toEqual([5, 900]);
  });

  it("keeps every channel of a tiled, Deflate-compressed 16-bit RGB image", async () => {
    const data = gray(5, 3, () => 0).flatMap(() => [4_000, 0, 2_000]);
    const result = await plane([
      { width: 5, height: 3, bits: 16, samples: 3, tile: 16, deflate: true, data },
    ]);
    const [r, g, b] = result.rgba;
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBeGreaterThan(100);
    expect(b).toBeLessThan(155);
  });

  it.each([
    [
      1,
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
    ],
    [
      2,
      [
        [3, 2, 1],
        [6, 5, 4],
      ],
    ],
    [
      3,
      [
        [6, 5, 4],
        [3, 2, 1],
      ],
    ],
    [
      4,
      [
        [4, 5, 6],
        [1, 2, 3],
      ],
    ],
    [
      5,
      [
        [1, 4],
        [2, 5],
        [3, 6],
      ],
    ],
    [
      6,
      [
        [4, 1],
        [5, 2],
        [6, 3],
      ],
    ],
    [
      7,
      [
        [6, 3],
        [5, 2],
        [4, 1],
      ],
    ],
    [
      8,
      [
        [3, 6],
        [2, 5],
        [1, 4],
      ],
    ],
  ])("places stored rows 1 2 3 / 4 5 6 on screen for orientation %i", async (orientation, rows) => {
    const result = await plane([
      { width: 3, height: 2, bits: 8, data: [1, 2, 3, 4, 5, 6], orientation },
    ]);
    const width = rows[0]!.length;
    expect([result.width, result.height]).toEqual([width, rows.length]);
    expect([result.info.width, result.info.height]).toEqual([width, rows.length]);
    const screen = rows.map((row, y) => row.map((_, x) => red(result.rgba, y * width + x)));
    expect(screen).toEqual(rows);
  });

  it.each([
    ["uncompressed rows", false],
    ["Deflate blocks", true],
  ])("keeps the precision of high-offset 32-bit integers read from %s", async (_path, deflate) => {
    const result = await plane([
      { width: 2, height: 1, bits: 32, data: [4_294_967_290, 4_294_967_295], deflate },
    ]);
    expect(result.info.range).toEqual([4_294_967_290, 4_294_967_295]);
    expect(red(result.rgba, 0)).toBe(0);
    expect(red(result.rgba, 1)).toBe(255);
  });

  it("keeps the precision of 64-bit floats in a narrow range", async () => {
    const result = await plane([
      { width: 2, height: 1, bits: 64, format: 3, data: [1e9 + 0.25, 1e9 + 0.75] },
    ]);
    expect(result.info.range).toEqual([1e9 + 0.25, 1e9 + 0.75]);
    expect(red(result.rgba, 0)).toBeLessThan(red(result.rgba, 1));
  });

  it("uses straight and premultiplied alpha from ExtraSamples", async () => {
    const straight = await plane([
      { width: 2, height: 1, bits: 8, samples: 2, extraSamples: [2], data: [100, 0, 200, 255] },
    ]);
    expect([...straight.rgba]).toEqual([100, 100, 100, 0, 200, 200, 200, 255]);

    const premultiplied = await plane([
      { width: 1, height: 1, bits: 8, samples: 2, extraSamples: [1], data: [50, 128] },
    ]);
    expect(red(premultiplied.rgba, 0)).toBe(100);
    expect(premultiplied.rgba[3]).toBe(128);

    const rgba = await plane([
      {
        width: 1,
        height: 1,
        bits: 16,
        samples: 4,
        extraSamples: [2],
        data: [4_000, 0, 2_000, 0],
      },
    ]);
    expect(rgba.rgba[3]).toBe(0);
    expect(rgba.info.range).toEqual([0, 4_000]);

    const unspecified = await plane([
      { width: 1, height: 1, bits: 8, samples: 4, extraSamples: [0], data: [1, 2, 3, 0] },
    ]);
    expect(unspecified.rgba[3]).toBe(255);
  });

  it("scales a plane above the pixel budget down by box averages and reports its true size", async () => {
    const data = gray(8, 6, (x) => (x % 2 ? 200 : 0));
    const result = await plane([{ width: 8, height: 6, bits: 8, data }], { maxOutputPixels: 12 });
    expect(result.info).toMatchObject({ width: 8, height: 6, scale: 0.5 });
    expect([result.width, result.height]).toEqual([4, 3]);
    expect(red(result.rgba, 0)).toBe(100);
  });

  it("shows 8-bit, palette and WhiteIsZero images as stored", async () => {
    const stored = await plane([{ width: 3, height: 1, bits: 8, data: [0, 17, 255] }]);
    expect([0, 1, 2].map((pixel) => red(stored.rgba, pixel))).toEqual([0, 17, 255]);
    expect(stored.info.display).toBeNull();

    const inverted = await plane([
      { width: 2, height: 1, bits: 8, data: [0, 255], photometric: 0 },
    ]);
    expect([...inverted.rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);

    const colorMap = Array.from({ length: 768 }, (_, index) =>
      index < 256 ? index * 257 : index >= 512 ? (255 - (index - 512)) * 257 : 0,
    );
    const palette = await plane([
      { width: 1, height: 1, bits: 8, data: [10], photometric: 3, colorMap },
    ]);
    expect([...palette.rgba]).toEqual([10, 0, 245, 255]);
  });

  it("uses a held display range instead of recomputing one", async () => {
    const tiff = await fromArrayBuffer(
      await tiffFixture([{ width: 2, height: 1, bits: 16, data: [1_000, 3_000] }]),
    );
    const result = await readTiffPlane(tiff, { plane: 0, heldDisplay: () => [0, 4_000] });
    expect(result.info.display).toEqual([0, 4_000]);
    expect(red(result.rgba, 0)).toBe(64);
  });

  it("refuses codecs whose output it cannot bound", async () => {
    const result = plane([
      {
        width: 1,
        height: 1,
        bits: 8,
        data: [],
        rawBlocks: { compression: 34_887, blocks: [new Uint8Array(4)] },
      },
    ]);
    await expect(result).rejects.toThrow("compression (LERC) isn't supported for preview");
  });

  it("names an unsupported compression", async () => {
    const bytes = await tiffFixture([{ width: 1, height: 1, bits: 8, data: [1] }]);
    const view = new DataView(bytes);
    // Compression (259) is the fourth entry of the first IFD.
    view.setUint16(view.getUint32(4, true) + 2 + 3 * 12 + 8, 34_712, true);
    const tiff = await fromArrayBuffer(bytes);
    await expect(readTiffPlane(tiff, { plane: 0 })).rejects.toThrow(
      "compression (JPEG 2000) isn't supported for preview",
    );
  });

  it("reports damaged directories as invalid metadata", async () => {
    const bytes = await tiffFixture([{ width: 1, height: 1, bits: 8, data: [1] }]);
    new DataView(bytes).setUint32(4, bytes.byteLength + 100, true);
    const result = fromArrayBuffer(bytes).then((tiff) => readTiffPlane(tiff, { plane: 0 }));
    await expect(result).rejects.toMatchObject({
      name: "TiffPreviewError",
      message: "Invalid TIFF metadata.",
    });
  });
});

describe("bounded TIFF block decoders", () => {
  const onePixel = (compression: number, block: Uint8Array) =>
    plane([
      { width: 1, height: 1, bits: 8, data: [], rawBlocks: { compression, blocks: [block] } },
    ]);

  it("decodes PackBits and stops a PackBits run that expands past the block", async () => {
    // -3 repeats the next byte four times.
    const runs = await plane([
      {
        width: 4,
        height: 1,
        bits: 8,
        data: [],
        rawBlocks: { compression: 32_773, blocks: [new Uint8Array([0xfd, 9])] },
      },
    ]);
    expect([0, 1, 2, 3].map((pixel) => red(runs.rgba, pixel))).toEqual([9, 9, 9, 9]);
    // 8 KiB of 128-byte runs would expand to 512 KiB for a one-byte image.
    const bomb = new Uint8Array(8_192).map((_, index) => (index % 2 ? 7 : 0x81));
    await expect(onePixel(32_773, bomb)).rejects.toThrow("oversized");
  });

  it("refuses a block whose stored size is far larger than its pixels", async () => {
    await expect(onePixel(1, new Uint8Array(200_000))).rejects.toThrow("oversized");
  });

  it("decodes Zstandard only when the frame declares a size that fits the block", async () => {
    const zstd = (bytes: Uint8Array) => new Uint8Array(NodeZlib.zstdCompressSync(bytes));
    const fits = await plane([
      {
        width: 2,
        height: 1,
        bits: 8,
        data: [],
        rawBlocks: { compression: 50_000, blocks: [zstd(new Uint8Array([3, 250]))] },
      },
    ]);
    expect([red(fits.rgba, 0), red(fits.rgba, 1)]).toEqual([3, 250]);
    await expect(onePixel(50_000, zstd(new Uint8Array(1 << 20)))).rejects.toThrow("oversized");
    // Frame header with no content size (descriptor 0), then one empty raw last block.
    const unsized = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x01, 0x00, 0x00]);
    expect(zstdContentSize(unsized)).toBeNull();
    await expect(onePixel(50_000, unsized)).rejects.toThrow("oversized");
  });

  it("refuses a JPEG block whose frame is larger than the block", async () => {
    const frame = [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0xea, 0x60, 0xea, 0x60, 1, 1, 0x11, 0];
    const jpeg = new Uint8Array([...frame, 0xff, 0xd9]);
    expect(jpegFrameSize(jpeg)).toMatchObject({ width: 60_000, height: 60_000 });
    await expect(onePixel(7, jpeg)).rejects.toThrow("oversized");
  });

  // Start-of-frame segment: height and width, then one component per entry as [id, sampling, table].
  const sof = (width: number, height: number, components = [[1, 0x11, 0]]) => [
    0xff,
    0xc0,
    0,
    8 + 3 * components.length,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    components.length,
    ...components.flat(),
  ];
  const jpeg = (...segments: number[][]) =>
    new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]);

  it("refuses a JPEG block with a second, larger frame", async () => {
    const block = jpeg(sof(1, 1), sof(2_048, 2_048));
    expect(jpegFrameSize(block)).toBeNull();
    await expect(onePixel(7, block)).rejects.toThrow("JPEG data isn't supported for preview");
  });

  it("refuses JPEG frames with out-of-range components or sampling", () => {
    expect(jpegFrameSize(jpeg(sof(1, 1)))).toEqual({
      width: 1,
      height: 1,
      sampling: [{ horizontal: 1, vertical: 1 }],
    });
    expect(jpegFrameSize(jpeg(sof(1, 1, [[1, 0x51, 0]])))).toBeNull();
    expect(
      jpegFrameSize(
        jpeg(
          sof(
            1,
            1,
            [1, 2, 3, 4, 5].map((id) => [id, 0x11, 0]),
          ),
        ),
      ),
    ).toBeNull();
  });

  it("refuses shared JPEG tables that carry a frame before any decoder is built", async () => {
    const result = plane([
      {
        width: 1,
        height: 1,
        bits: 8,
        data: [],
        jpegTables: jpeg(sof(2_048, 2_048)),
        rawBlocks: { compression: 7, blocks: [jpeg(sof(1, 1))] },
      },
    ]);
    await expect(result).rejects.toThrow("JPEG data isn't supported for preview");
  });

  it("decodes a wide row of tiles a few at a time within the byte budget", async () => {
    // geotiff decodes every tile of a window at once, so the window bounds the tiles in flight.
    using readRasters = vi.spyOn(GeoTIFFImage.prototype, "readRasters");
    const data = Array.from({ length: 256 * 16 }, (_, index) => (index * 7) % 256);
    const tiff = await fromArrayBuffer(
      await tiffFixture([{ width: 256, height: 16, bits: 8, tile: 16, data }]),
    );
    // Sixteen 256-byte tiles across, each with a 256-byte window copy: four fit in 2 KiB.
    const result = await readTiffPlane(tiff, { plane: 0, bandBytes: 2_048 });
    const tiles = readRasters.mock.calls.map(([options]) => {
      const [left, top, right, bottom] = options!.window!;
      return (
        (Math.ceil(right! / 16) - Math.floor(left! / 16)) *
        (Math.ceil(bottom! / 16) - Math.floor(top! / 16))
      );
    });
    expect(tiles).toEqual([4, 4, 4, 4]);
    expect(Array.from({ length: data.length }, (_, pixel) => result.rgba[pixel * 4])).toEqual(data);
  });

  const TOO_LARGE = "This TIFF's JPEG tiles are too large to preview.";
  const rgbFrame = (width: number, height: number) =>
    jpeg(
      sof(
        width,
        height,
        [1, 2, 3].map((id) => [id, 0x11, 0]),
      ),
    );

  it("refuses one JPEG frame whose decoding memory far exceeds its tile", async () => {
    // Codex's 26-byte case scaled up: four 2048×2048 components inside a one-sample 4 MiB strip.
    const block = jpeg(
      sof(
        2_048,
        2_048,
        [1, 2, 3, 4].map((id) => [id, 0x11, 0]),
      ),
    );
    expect(block.length).toBe(26);
    expect(jpegWorkingBytes(jpegFrameSize(block)!)).toBeGreaterThan(JPEG_TILE_BYTES);
    const result = plane([
      {
        width: 2_048,
        height: 2_048,
        bits: 8,
        data: [],
        rawBlocks: { compression: 7, blocks: [block] },
      },
    ]);
    await expect(result).rejects.toThrow(TOO_LARGE);
  });

  it("refuses JPEG tiles just over the one-tile limit before reading them", async () => {
    expect(jpegTileWorkingBytes(2_048, 1_264, 3)).toBeLessThanOrEqual(JPEG_TILE_BYTES);
    expect(jpegTileWorkingBytes(2_048, 1_280, 3)).toBeGreaterThan(JPEG_TILE_BYTES);
    const result = plane([
      {
        width: 2_048,
        height: 1_280,
        bits: 8,
        samples: 3,
        data: [],
        rawBlocks: { compression: 7, blocks: [rgbFrame(1, 1)] },
      },
    ]);
    await expect(result).rejects.toThrow(TOO_LARGE);
  });

  it("lets 1024×1024 RGB JPEG tiles through and reads each one alone", async () => {
    using readRasters = vi.spyOn(GeoTIFFImage.prototype, "readRasters");
    // Frames without scan data: the decoder fails after the memory checks, which is enough here.
    const result = plane([
      {
        width: 2_048,
        height: 1_024,
        bits: 8,
        samples: 3,
        tile: 1_024,
        data: [],
        rawBlocks: { compression: 7, blocks: [rgbFrame(1_024, 1_024), rgbFrame(1_024, 1_024)] },
      },
    ]);
    await expect(result).rejects.not.toThrow(TOO_LARGE);
    await expect(result).rejects.toThrow();
    expect(readRasters.mock.calls[0]?.[0]?.window).toEqual([0, 0, 1_024, 1_024]);
  });

  it("decodes a normal 256×256 JPEG tile", async () => {
    // Grey 77 above row 128 and 200 below, baseline JPEG from imagecodecs.
    const tile = Uint8Array.from(atob(JPEG_256), (char) => char.charCodeAt(0));
    const result = await plane([
      {
        width: 256,
        height: 256,
        bits: 8,
        tile: 256,
        data: [],
        rawBlocks: { compression: 7, blocks: [tile] },
      },
    ]);
    expect(red(result.rgba, 0)).toBe(77);
    expect(red(result.rgba, 256 * 256 - 1)).toBe(200);
  });

  it("refuses a false block count before geotiff allocates from it", async () => {
    const bytes = await tiffFixture([{ width: 1, height: 1, bits: 8, data: [7] }]);
    const view = new DataView(bytes);
    const ifd = view.getUint32(4, true);
    const entries = view.getUint16(ifd, true);
    const stripOffsets = Array.from({ length: entries }, (_, index) => ifd + 2 + index * 12).find(
      (at) => view.getUint16(at, true) === 273,
    )!;
    // 2^30 LONG offsets would be a 4 GiB array.
    view.setUint32(stripOffsets + 4, 2 ** 30, true);
    const large: number[] = [];
    const Real = globalThis.Uint32Array;
    vi.stubGlobal(
      "Uint32Array",
      new Proxy(Real, {
        construct(target, args: unknown[]) {
          if (typeof args[0] === "number" && args[0] > 1 << 24) {
            large.push(args[0]);
            throw new RangeError("large test allocation");
          }
          return Reflect.construct(target, args) as object;
        },
      }),
    );
    try {
      const result = fromArrayBuffer(bytes).then((tiff) => readTiffPlane(tiff, { plane: 0 }));
      await expect(result).rejects.toThrow("This TIFF's layout isn't supported for preview.");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(large).toEqual([]);
  });

  it.each([
    [12, [100, 4_000]],
    [20, [65_536, 131_072]],
    [24, [1, 16_000_000]],
  ])("keeps %i-bit samples whole", async (bits, values) => {
    const result = await plane([
      {
        width: 2,
        height: 1,
        bits,
        data: [],
        // Whole-byte widths follow the file's (little-endian) byte order; others pack high bit first.
        rawBlocks: {
          compression: 1,
          blocks: [
            bits === 24
              ? new Uint8Array(
                  values.flatMap((value) => [value & 255, (value >> 8) & 255, value >> 16]),
                )
              : packSamples(values, bits),
          ],
        },
      },
    ]);
    expect(result.info.range).toEqual(values);
    expect([red(result.rgba, 0), red(result.rgba, 1)]).toEqual([0, 255]);
  });

  it("reads 1-bit samples packed high bit first", async () => {
    const result = await plane([
      {
        width: 8,
        height: 1,
        bits: 1,
        data: [],
        rawBlocks: { compression: 1, blocks: [new Uint8Array([0b1011_0000])] },
      },
    ]);
    expect([0, 1, 2, 3, 4].map((pixel) => red(result.rgba, pixel))).toEqual([255, 0, 255, 255, 0]);
  });

  it.each([
    [25, [16_777_216, 16_777_217]],
    [31, [1, 2, 3, 4, 5, 6, 7, 8]],
  ])("refuses %i-bit samples, which can span five bytes", async (bits, values) => {
    const result = plane([
      {
        width: values.length,
        height: 1,
        bits,
        data: [],
        rawBlocks: { compression: 1, blocks: [packSamples(values, bits)] },
      },
    ]);
    await expect(result).rejects.toThrow("This TIFF's sample width isn't supported for preview.");
  });

  it("refuses bits stored lowest first", async () => {
    const result = plane([
      {
        width: 8,
        height: 1,
        bits: 1,
        data: [],
        rawBlocks: { compression: 1, blocks: [new Uint8Array([0x0d])] },
        rawEntries: [{ tag: 266, type: 3, count: 1, offset: 2 }],
      },
    ]);
    await expect(result).rejects.toThrow("bit order (FillOrder 2) isn't supported for preview");
  });

  it("refuses an uncompressed row too wide to read within the tile budget", async () => {
    // One 1,048,576-pixel row of 64 Float64 samples is 512 MiB.
    const result = plane([
      {
        width: 1 << 20,
        height: 1,
        bits: 64,
        format: 3,
        samples: 64,
        photometric: 1,
        data: [],
        rawBlocks: { compression: 1, blocks: [new Uint8Array(8)] },
      },
    ]);
    await expect(result).rejects.toThrow("blocks too large to preview");
  });

  it.each([
    ["1/25/25", [1, 25, 25]],
    ["5/6/5", [5, 6, 5]],
  ])("refuses RGB samples of unequal widths (%s)", async (_name, widths) => {
    const result = plane([
      {
        width: 1,
        height: 1,
        bits: widths[0]!,
        bitsPerSample: widths,
        samples: 3,
        data: [],
        rawBlocks: { compression: 1, blocks: [new Uint8Array(8)] },
      },
    ]);
    await expect(result).rejects.toThrow("This TIFF's sample width isn't supported for preview.");
  });

  it.each([8, 16] as const)("opens %i/%i/%i-bit RGB", async (bits) => {
    const top = bits === 8 ? 255 : 65_535;
    const result = await plane([
      { width: 2, height: 1, bits, samples: 3, data: [top, 0, 0, 0, top, 0] },
    ]);
    expect(Array.from(result.rgba.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(result.rgba.subarray(4, 7))).toEqual([0, 255, 0]);
  });

  it("takes a missing BitsPerSample as 1, as bilevel files do", async () => {
    const result = await plane([
      {
        width: 8,
        height: 1,
        bits: 1,
        omitBitsPerSample: true,
        data: [],
        rawBlocks: { compression: 1, blocks: [new Uint8Array([0b1011_0000])] },
      },
    ]);
    expect(result.info.bits).toBe(1);
    expect([0, 1, 2, 3, 4].map((pixel) => red(result.rgba, pixel))).toEqual([255, 0, 255, 255, 0]);
  });

  it("refuses a 1-bit image whose unpacked copy is far larger than its packed bytes", async () => {
    using allocations = watchAllocations("Uint8Array", 1 << 26);
    // 32 MB packed, 256 MB once geotiff widens each bit to a byte.
    const result = plane([
      {
        width: 16_000,
        height: 16_000,
        bits: 1,
        data: [],
        rawBlocks: { compression: 1, blocks: [new Uint8Array(1)] },
      },
    ]);
    await expect(result).rejects.toThrow("blocks too large to preview");
    expect(allocations.large).toEqual([]);
  });

  it("refuses metadata that points past the end of the file", async () => {
    const result = plane([
      {
        width: 1,
        height: 1,
        bits: 8,
        data: [1],
        rawEntries: [{ tag: 320, type: 3, count: 1 << 20, offset: 100_000_000 }],
      },
    ]);
    await expect(result).rejects.toThrow("Invalid TIFF metadata.");
  });

  it("refuses metadata that adds up past the budget across directories", async () => {
    // Forty directories each declare a 2 MiB array over the first page's real pixels.
    const big = { width: 1_536, height: 1_536, bits: 8, data: new Uint8Array(1_536 * 1_536) };
    const result = plane([
      big,
      ...Array.from({ length: 40 }, () => ({
        width: 1,
        height: 1,
        bits: 8,
        data: [1],
        rawEntries: [{ tag: 320, type: 3, count: 1 << 20, offset: 16 }],
      })),
    ]);
    await expect(result).rejects.toThrow("This TIFF's layout isn't supported for preview.");
  });

  it("refuses Codex's forty-directory file before any large array is allocated", async () => {
    using allocations = watchAllocations("Uint16Array", 1 << 22);
    const result = plane(
      Array.from({ length: 40 }, () => ({
        width: 1,
        height: 1,
        bits: 8,
        data: [1],
        rawEntries: [{ tag: 320, type: 3, count: 8 << 20, offset: 4_096 }],
      })),
    );
    await expect(result).rejects.toThrow("Invalid TIFF metadata.");
    expect(allocations.large).toEqual([]);
  });

  it("parses only the directory it shows", async () => {
    using allocations = watchAllocations("Uint16Array", 1 << 19);
    const big = { width: 1_536, height: 1_536, bits: 8, data: new Uint8Array(1_536 * 1_536) };
    const result = await plane([
      big,
      {
        width: 1,
        height: 1,
        bits: 8,
        data: [1],
        rawEntries: [{ tag: 320, type: 3, count: 1 << 20, offset: 16 }],
      },
    ]);
    expect(result.info).toMatchObject({ plane: 0, planes: 2 });
    expect(allocations.large).toEqual([]);
  });

  it("refuses a planar Float64 RGBA tile larger than one tile's budget", async () => {
    const result = plane([
      {
        width: 4_096,
        height: 3_904,
        bits: 64,
        format: 3,
        samples: 4,
        extraSamples: [2],
        planar: 2,
        tile: 4_096,
        tileHeight: 3_904,
        data: [],
        rawBlocks: { compression: 1, blocks: [1, 2, 3, 4].map(() => new Uint8Array(8)) },
      },
    ]);
    await expect(result).rejects.toThrow("blocks too large to preview");
  });

  it("refuses tiles far larger than a thin image", async () => {
    const result = plane([
      {
        width: 512,
        height: 1,
        bits: 8,
        data: [],
        tile: 16,
        tileHeight: 65_536,
        rawBlocks: { compression: 1, blocks: Array.from({ length: 32 }, () => new Uint8Array(1)) },
      },
    ]);
    await expect(result).rejects.toThrow("tiles are far larger than its image");
  });

  const JPEG_256 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAEAAQABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APneiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiv1Iooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooor//2Q==";

  // 16×16 bytes (x * 7 + y * 3) % 16, LZW-encoded by imagecodecs.
  const LZW =
    "gAAA4OAoMAYKAIIB4GBoEBYCBMHhMLhsPBMCggMhkOiEYgsShUXgcfhEKjcPg0likckUElcWj0phMdkcyk0VkkTk80B03lkxiUwmsglcZok7kU6is8kk/ocqhlPpU/qFLlsfq1AqEBA=";
  const lzw = Uint8Array.from(atob(LZW), (char) => char.charCodeAt(0));
  const expected = Array.from(
    { length: 256 },
    (_, index) => ((index % 16) * 7 + Math.floor(index / 16) * 3) % 16,
  );

  it("decodes LZW exactly", () => {
    expect([...new Uint8Array(decodeLzw(lzw, 256))]).toEqual(expected);
  });

  it("rejects blocks that expand past their declared size", async () => {
    expect(() => decodeLzw(lzw, 100)).toThrow("oversized");
    const zeros = new Uint8Array(1 << 20);
    const stream = new Blob([zeros]).stream().pipeThrough(new CompressionStream("deflate"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    await expect(inflateBounded(compressed, 1_000)).rejects.toThrow("oversized");
    expect(new Uint8Array(await inflateBounded(compressed, 1 << 20))).toEqual(zeros);
  });
});
