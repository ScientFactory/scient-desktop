// @effect-diagnostics nodeBuiltinImport:off -- Node's Zstandard encoder builds the test blocks.
import * as NodeZlib from "node:zlib";

import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vite-plus/test";

import { tiffFixture, type TiffFixturePage } from "../../../../test/tiffFixture";
import {
  decodeLzw,
  inflateBounded,
  jpegFrameSize,
  registerBoundedTiffDecoders,
  zstdContentSize,
} from "./tiffBlockDecoders";
import { readTiffPlane, tiffPlaneLabel } from "./tiffPreview";

registerBoundedTiffDecoders();

const gray = (width: number, height: number, value: (x: number, y: number) => number) =>
  Array.from({ length: width * height }, (_, index) =>
    value(index % width, Math.floor(index / width)),
  );

async function plane(
  pages: readonly TiffFixturePage[],
  options: { plane?: number; bigTiff?: boolean; maxOutputPixels?: number } = {},
) {
  const tiff = await fromArrayBuffer(
    await tiffFixture(pages, { bigTiff: options.bigTiff ?? false }),
  );
  return readTiffPlane(tiff, {
    plane: options.plane ?? 0,
    ...(options.maxOutputPixels ? { maxOutputPixels: options.maxOutputPixels } : {}),
  });
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
    expect(jpegFrameSize(jpeg)).toEqual({ width: 60_000, height: 60_000 });
    await expect(onePixel(7, jpeg)).rejects.toThrow("oversized");
  });

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
