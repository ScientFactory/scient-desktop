import type { GeoTIFF, GeoTIFFImage } from "geotiff";

import { checkTiffLayout, LAYOUT_INVALID, LAYOUT_UNSUPPORTED } from "./tiffLayout";
import {
  compressionName,
  guardTiffDecoder,
  JPEG_TILE_BYTES,
  JPEG_TOO_LARGE,
  jpegTileWorkingBytes,
  maxCompressedBytes,
  PREVIEW_COMPRESSIONS,
  registerBoundedTiffDecoders,
} from "./tiffBlockDecoders";

const MAX_OUTPUT_PIXELS = 32_000_000;
const MAX_OUTPUT_SIDE = 16_384;
const MAX_SOURCE_SIDE = 1 << 20;
const MAX_SOURCE_PIXELS = 256_000_000;
// Peak decode memory stays under about 400 MiB: values up to 128 MiB, one window's blocks up to
// 64 MiB plus 1.5× compressed and a 64 MiB interleaved copy, and 128 MiB of RGBA at 32 MP.
// PNG encoding later holds the RGBA, the canvas and the PNG, also under about 400 MiB.
const TILE_BYTES = 64 * 1024 * 1024;
const VALUES_BYTES = 128 * 1024 * 1024;
// Decoded bytes read at once; a window always holds at least one block, so a larger block is read alone.
const BAND_BYTES = 16 * 1024 * 1024;
// Fiji's Enhance Contrast default, split between both ends of the histogram.
const SATURATED = 0.0035;

export type TiffAxisName = "C" | "Z" | "T";

export interface TiffAxis {
  readonly name: TiffAxisName;
  readonly size: number;
}

export interface TiffPreviewInfo {
  readonly width: number;
  readonly height: number;
  readonly plane: number;
  readonly planes: number;
  readonly axes: readonly TiffAxis[];
  readonly channel: number;
  readonly bits: number;
  readonly format: "uint" | "int" | "float";
  readonly range: readonly [number, number] | null;
  readonly display: readonly [number, number] | null;
  readonly scale: number;
}

export interface TiffPlane {
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  readonly info: TiffPreviewInfo;
}

export interface TiffPreviewError extends Error {
  readonly name: "TiffPreviewError";
  /** "load" failures renew or retry the file URL; "format" failures explain themselves. */
  readonly kind: "format" | "load";
}

export function tiffPreviewError(
  message: string,
  kind: TiffPreviewError["kind"] = "format",
): TiffPreviewError {
  return Object.assign(new Error(message), { name: "TiffPreviewError" as const, kind });
}

export function isTiffPreviewError(cause: unknown): cause is TiffPreviewError {
  return cause instanceof Error && cause.name === "TiffPreviewError";
}

// geotiff reports damaged headers and directories as generic or range errors.
export function asMetadataError(cause: unknown): never {
  if (isTiffPreviewError(cause)) throw cause;
  if (cause instanceof Error && cause.name === "AbortError") throw cause;
  throw tiffPreviewError("Invalid TIFF metadata.");
}

interface Layout {
  readonly pages: readonly number[] | null;
  readonly pageCount: number;
  readonly samplesAsChannels: number;
  readonly axes: readonly TiffAxis[];
  readonly displayHint: readonly [number, number] | null;
}

interface Description {
  readonly count: number;
  readonly axes: readonly TiffAxis[];
  readonly displayHint: readonly [number, number] | null;
}

function parseDescription(description: string | undefined): Description | null {
  if (!description) return null;
  const pixels = /<(?:\w+:)?Pixels\b([^>]*)>/u.exec(description)?.[1];
  if (pixels !== undefined && /<(?:\w+:)?OME\b/u.test(description)) {
    const size = (name: string) =>
      Number(new RegExp(`\\b${name}="(\\d+)"`, "u").exec(pixels)?.[1] ?? 1) || 1;
    const order = /\bDimensionOrder="XY([ZCT]{3})"/u.exec(pixels)?.[1] ?? "ZCT";
    const sizes = { Z: size("SizeZ"), C: size("SizeC"), T: size("SizeT") };
    // An RGB channel keeps its samples inside one plane.
    const samples = Number(
      /<(?:\w+:)?Channel\b[^>]*\bSamplesPerPixel="(\d+)"/u.exec(description)?.[1] ?? 1,
    );
    if (samples > 1) sizes.C = Math.max(1, Math.round(sizes.C / samples));
    const axes = [...order].map((name) => ({
      name: name as TiffAxisName,
      size: sizes[name as TiffAxisName],
    }));
    return { count: sizes.Z * sizes.C * sizes.T, axes, displayHint: null };
  }
  if (!description.startsWith("ImageJ=")) return null;
  const value = (key: string) => {
    const match = new RegExp(`^${key}=([-0-9.eE+]+)$`, "mu").exec(description)?.[1];
    return match === undefined ? undefined : Number(match);
  };
  const sizes = { C: value("channels") ?? 1, Z: value("slices") ?? 1, T: value("frames") ?? 1 };
  const count = value("images") ?? sizes.C * sizes.Z * sizes.T;
  const min = value("min");
  const max = value("max");
  return {
    count,
    axes:
      sizes.C * sizes.Z * sizes.T === count
        ? (["C", "Z", "T"] as const).map((name) => ({ name, size: sizes[name] }))
        : [],
    // ImageJ's min/max is the first channel's range; composites keep theirs elsewhere.
    displayHint:
      sizes.C === 1 && min !== undefined && max !== undefined && max > min ? [min, max] : null,
  };
}

async function describeLayout(
  tiff: GeoTIFF,
  first: GeoTIFFImage,
  directories: number,
): Promise<Layout> {
  const directory = first.getFileDirectory();
  const description = directory.hasTag("ImageDescription")
    ? String(await directory.loadValue("ImageDescription"))
    : undefined;
  const photometric = Number(directory.getValue("PhotometricInterpretation") ?? 1);
  const colour = first.getSamplesPerPixel() - (await extraSamples(first)).length;
  const rgb = (photometric === 2 || photometric === 6) && colour >= 3;
  const samplesAsChannels = !rgb && photometric !== 3 && colour > 1 ? colour : 1;
  const parsed = parseDescription(description);
  // Multi-file OME and ImageJ's >4 GB stacks describe planes this file does not hold.
  if (parsed && parsed.count >= 1 && parsed.count <= directories) {
    const present = await tiff.getImage(parsed.count - 1).then(
      () => true,
      () => false,
    );
    if (present) return { pages: null, pageCount: parsed.count, samplesAsChannels, ...parsed };
  }
  const pages: number[] = [];
  for (let index = 0; index < directories; index++) {
    const image = await tiff.getImage(index).catch(() => null);
    if (!image) break;
    // Skip reduced-resolution and mask images.
    if (!(Number(image.getFileDirectory().getValue("NewSubfileType") ?? 0) & 0b101))
      pages.push(index);
  }
  return {
    pages,
    pageCount: pages.length,
    samplesAsChannels,
    axes: [],
    displayHint: parsed?.displayHint ?? null,
  };
}

async function extraSamples(image: GeoTIFFImage) {
  const directory = image.getFileDirectory();
  if (!directory.hasTag("ExtraSamples")) return [];
  const value: unknown = await directory.loadValue("ExtraSamples");
  return typeof value === "number" ? [value] : Array.from(value as ArrayLike<number>, Number);
}

// Where stored pixel (x, y) lands on screen; 5–8 put stored rows in screen columns.
const ORIENTATIONS: Record<
  number,
  (x: number, y: number, w: number, h: number) => [number, number]
> = {
  1: (x, y) => [x, y],
  2: (x, y, w) => [w - 1 - x, y],
  3: (x, y, w, h) => [w - 1 - x, h - 1 - y],
  4: (x, y, _w, h) => [x, h - 1 - y],
  5: (x, y) => [y, x],
  6: (x, y, _w, h) => [h - 1 - y, x],
  7: (x, y, w, h) => [h - 1 - y, w - 1 - x],
  8: (x, y, w) => [y, w - 1 - x],
};

function orientation(value: number, width: number, height: number) {
  const place = ORIENTATIONS[value] ?? ORIENTATIONS[1]!;
  const swap = value >= 5 && value <= 8;
  const outWidth = swap ? height : width;
  return {
    swap,
    at: (x: number, y: number) => {
      const [screenX, screenY] = place(x, y, width, height);
      return screenY * outWidth + screenX;
    },
  };
}

type Band = ArrayLike<number>;

// Uncompressed rows are fetched directly, so a one-strip image never needs a whole-strip buffer.
async function readRawRows(
  image: GeoTIFFImage,
  top: number,
  bottom: number,
  read: readonly number[],
  precise: boolean,
  signal: AbortSignal | undefined,
): Promise<Band> {
  const width = image.getWidth();
  const samples = image.getSamplesPerPixel();
  const bytes = image.getBitsPerSample(0) / 8;
  const rowBytes = width * samples * bytes;
  const rowsPerStrip = image.getTileHeight();
  const directory = image.getFileDirectory();
  const readers = read.map((sample) => image.getReaderForSample(sample));
  const length = (bottom - top) * width * read.length;
  const out = precise ? new Float64Array(length) : new Float32Array(length);
  for (let y = top; y < bottom;) {
    const strip = Math.floor(y / rowsPerStrip);
    const rows = Math.min(bottom, (strip + 1) * rowsPerStrip) - y;
    const offset =
      Number(await directory.loadValueIndexed("StripOffsets", strip)) +
      (y - strip * rowsPerStrip) * rowBytes;
    const [slice] = await image.source.fetch([{ offset, length: rows * rowBytes }], signal);
    const view = new DataView(slice!);
    for (let row = 0; row < rows; row++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < read.length; c++)
          out[((y - top + row) * width + x) * read.length + c] = readers[c]!.call(
            view,
            (row * width + x) * samples * bytes + read[c]! * bytes,
            image.littleEndian,
          );
    y += rows;
  }
  return out;
}

function percentileRange(
  values: ArrayLike<number>,
  channels: number,
  colour: number,
  min: number,
  max: number,
  integer: boolean,
): [number, number] {
  const bins = integer ? Math.floor(max - min) + 1 : 4096;
  const width = integer ? 1 : (max - min) / bins;
  const histogram = new Uint32Array(bins);
  let total = 0;
  for (let index = 0; index < values.length; index += channels) {
    for (let c = 0; c < colour; c++) {
      const value = values[index + c]!;
      if (Number.isNaN(value)) continue;
      histogram[Math.min(bins - 1, Math.floor(width ? (value - min) / width : 0))]!++;
      total++;
    }
  }
  const cut = total * (SATURATED / 2);
  let low = 0;
  let below = histogram[0]!;
  while (low < bins - 1 && below <= cut) below += histogram[++low]!;
  let high = bins - 1;
  let above = histogram[high]!;
  while (high > 0 && above <= cut) above += histogram[--high]!;
  return [min + low * width, min + (high + (integer ? 0 : 1)) * width];
}

function axisIndices(plane: number, axes: readonly TiffAxis[]) {
  let rest = plane;
  return axes.map((axis) => {
    const index = rest % axis.size;
    rest = Math.floor(rest / axis.size);
    return { axis, index };
  });
}

export function tiffPlaneLabel(info: Pick<TiffPreviewInfo, "plane" | "planes" | "axes">) {
  if (info.planes <= 1) return null;
  const order = { C: 0, Z: 1, T: 2 };
  const parts = axisIndices(info.plane, info.axes)
    .filter(({ axis }) => axis.size > 1)
    .toSorted((left, right) => order[left.axis.name] - order[right.axis.name]);
  if (!parts.length) return `Page ${info.plane + 1} of ${info.planes}`;
  return parts.map(({ axis, index }) => `${axis.name} ${index + 1}/${axis.size}`).join(" · ");
}

export async function readTiffPlane(
  tiff: GeoTIFF,
  request: {
    readonly plane: number;
    readonly heldDisplay?: (channel: number) => readonly [number, number] | undefined;
    readonly maxOutputPixels?: number;
    /** Decoded bytes allowed in flight at once; tests lower it. */
    readonly bandBytes?: number;
    readonly signal?: AbortSignal;
  },
): Promise<TiffPlane> {
  const { signal } = request;
  registerBoundedTiffDecoders();
  const directories = await checkTiffLayout(tiff).catch((cause: unknown) => {
    if (cause instanceof Error && [LAYOUT_INVALID, LAYOUT_UNSUPPORTED].includes(cause.message))
      throw tiffPreviewError(cause.message);
    return asMetadataError(cause);
  });
  const first = await tiff.getImage(0).catch(asMetadataError);
  const layout = await describeLayout(tiff, first, directories).catch(asMetadataError);
  const planes = layout.pageCount * layout.samplesAsChannels;
  if (planes < 1) throw tiffPreviewError("This TIFF has no readable image.");
  const plane = Math.min(Math.max(0, Math.trunc(request.plane)), planes - 1);
  const page = Math.floor(plane / layout.samplesAsChannels);
  const image = await tiff
    .getImage(layout.pages ? layout.pages[page]! : page)
    .catch(asMetadataError);
  const directory = image.getFileDirectory();
  const width = image.getWidth();
  const height = image.getHeight();
  if (!(width > 0 && height > 0) || width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE)
    throw tiffPreviewError("This TIFF's dimensions are not supported.");
  if (width * height > MAX_SOURCE_PIXELS)
    throw tiffPreviewError(
      `This image is too large to preview (${Math.round((width * height) / 1e6).toLocaleString()} megapixels).`,
    );
  const photometric = Number(directory.getValue("PhotometricInterpretation") ?? 1);
  const compression = Number(directory.getValue("Compression") ?? 1);
  if (!PREVIEW_COMPRESSIONS.has(compression))
    throw tiffPreviewError(
      `This TIFF's compression (${compressionName(compression)}) isn't supported for preview.`,
    );
  guardTiffDecoder(compression);
  if (![0, 1, 2, 3].includes(photometric) && !(photometric === 6 && compression === 7))
    throw tiffPreviewError("This TIFF color format is not supported.");
  const samples = image.getSamplesPerPixel();
  const bits = image.getBitsPerSample(0);
  const sampleFormat = image.getSampleFormat(0);
  const format = sampleFormat === 3 ? "float" : sampleFormat === 2 ? "int" : "uint";
  const colorMap = photometric === 3 ? await directory.loadValue("ColorMap") : undefined;
  const palette = colorMap ? Array.from(colorMap, Number) : null;
  if (photometric === 3 && !palette) throw tiffPreviewError("This TIFF's palette is missing.");
  const extras = await extraSamples(image);
  const colourSamples = samples - extras.length;
  const rgb = !palette && layout.samplesAsChannels === 1 && colourSamples >= 3;
  // ExtraSamples 1 is premultiplied (associated) alpha and 2 is straight alpha.
  const alphaExtra = extras.findIndex((value) => value === 1 || value === 2);
  const alpha = alphaExtra >= 0;
  const associated = alpha && extras[alphaExtra] === 1;
  const read = [
    ...(rgb ? [0, 1, 2] : [plane % layout.samplesAsChannels]),
    ...(alpha ? [colourSamples + alphaExtra] : []),
  ];
  const channels = read.length;
  const alphaMax = format === "float" ? 1 : 2 ** bits - 1;
  const rawRows =
    compression === 1 && !image.isTiled && image.planarConfiguration === 1 && bits % 8 === 0;
  const allBits = Array.from(
    ((await directory.loadValue("BitsPerSample")) as ArrayLike<number> | undefined) ?? [bits],
    Number,
  );
  const blockBits =
    image.planarConfiguration === 2 ? bits : allBits.reduce((sum, value) => sum + value, 0);
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const tilesAcross = Math.ceil(width / tileWidth);
  const blockDecoded = Math.ceil((tileWidth * blockBits) / 8) * tileHeight;
  // A block, with every sample read from it, is decoded whole whatever the window budget.
  const blockSamples = image.planarConfiguration === 2 ? channels : 1;
  if (!rawRows && blockDecoded * blockSamples > TILE_BYTES)
    throw tiffPreviewError("This TIFF stores its image in blocks too large to preview.");
  // Edge tiles are decoded whole, so a thin image must not hide tiles far larger than itself.
  if (
    tilesAcross * tileWidth * Math.ceil(height / tileHeight) * tileHeight >
    4 * width * height + tileWidth * tileHeight
  )
    throw tiffPreviewError("This TIFF's tiles are far larger than its image.");
  // Every block is checked before it is fetched, so a false byte count cannot pull in a whole file.
  const byteCounts = (await directory.loadValue(
    image.isTiled ? "TileByteCounts" : "StripByteCounts",
  )) as ArrayLike<number | bigint> | undefined;
  if (
    Array.from(byteCounts ?? [], Number).some((count) => count > maxCompressedBytes(blockDecoded))
  )
    throw tiffPreviewError("This TIFF has an oversized compressed block.");
  // 32-bit integers and 64-bit floats lose precision in Float32, so they keep doubles at half the pixels.
  const precise = bits > 32 || (bits === 32 && format !== "float");

  // Values keep the source's own integer type when every output pixel is one source pixel.
  const floatBytes = precise ? 8 : 4;
  const nativeBytes = format === "float" || precise || associated ? floatBytes : bits <= 8 ? 1 : 2;
  const scaleFor = (bytesPerPixel: number) => {
    const pixels = Math.min(
      request.maxOutputPixels ?? MAX_OUTPUT_PIXELS,
      Math.floor(VALUES_BYTES / bytesPerPixel),
    );
    return Math.max(
      1,
      Math.ceil(Math.sqrt((width * height) / pixels)),
      Math.ceil(Math.max(width, height) / MAX_OUTPUT_SIDE),
    );
  };
  let factor = scaleFor(nativeBytes * channels);
  // Averaging needs float sums and a count per output pixel.
  if (factor > 1) factor = scaleFor(floatBytes * channels + (palette ? 0 : 2));
  const outWidth = Math.ceil(width / factor);
  const outHeight = Math.ceil(height / factor);
  const length = outWidth * outHeight * channels;
  const values =
    factor > 1 || nativeBytes === floatBytes
      ? (precise ? new Float64Array(length) : new Float32Array(length)).fill(Number.NaN)
      : nativeBytes === 1
        ? format === "int"
          ? new Int8Array(length)
          : new Uint8Array(length)
        : format === "int"
          ? new Int16Array(length)
          : new Uint16Array(length);
  const counts = factor > 1 && !palette ? new Uint16Array(outWidth * outHeight) : null;
  // geotiff decodes every block of a window at once, so windows hold a bounded number of blocks.
  const bandBytes = request.bandBytes ?? BAND_BYTES;
  // geotiff's JPEG decoder needs several times a tile's pixels while it works.
  const jpegWorking =
    compression === 7
      ? jpegTileWorkingBytes(tileWidth, tileHeight, image.planarConfiguration === 2 ? 1 : samples)
      : 0;
  if (jpegWorking > JPEG_TILE_BYTES) throw tiffPreviewError(JPEG_TOO_LARGE);
  const blockWorking = Math.max(blockDecoded, jpegWorking);
  const blockInFlight = blockWorking * blockSamples;
  const blocksPerBand = Math.max(1, Math.floor(bandBytes / blockInFlight));
  let bandRows = tileHeight;
  let bandColumns = width;
  if (rawRows)
    bandRows = Math.max(
      1,
      Math.floor(bandBytes / (width * Math.max(image.getBytesPerPixel(), channels * floatBytes))),
    );
  else if (!image.isTiled || tilesAcross <= blocksPerBand)
    bandRows = tileHeight * Math.max(1, Math.floor(blocksPerBand / tilesAcross));
  else bandColumns = tileWidth * blocksPerBand;
  let min = Infinity;
  let max = -Infinity;
  const pixelValues = new Float64Array(channels);
  for (let top = 0; top < height; top += bandRows)
    for (let left = 0; left < width; left += bandColumns) {
      signal?.throwIfAborted();
      const bottom = Math.min(height, top + bandRows);
      const right = Math.min(width, left + bandColumns);
      const span = right - left;
      const band: Band = rawRows
        ? await readRawRows(image, top, bottom, read, precise, signal)
        : await image.readRasters({
            window: [left, top, right, bottom],
            samples: [...read],
            interleave: true,
            ...(signal ? { signal } : {}),
          });
      for (let y = top; y < bottom; y++) {
        const outRow = Math.floor(y / factor) * outWidth;
        for (let x = left; x < right; x++) {
          const source = ((y - top) * span + (x - left)) * channels;
          const target = (outRow + Math.floor(x / factor)) * channels;
          let finite = true;
          for (let c = 0; c < channels; c++) {
            const value = band[source + c]!;
            if (!Number.isFinite(value)) finite = false;
            pixelValues[c] = value;
          }
          if (!finite) continue;
          if (associated) {
            const opacity = pixelValues[channels - 1]! / alphaMax;
            for (let c = 0; c < channels - 1; c++)
              pixelValues[c] = opacity > 0 ? pixelValues[c]! / opacity : 0;
          }
          for (let c = 0; c < (alpha ? channels - 1 : channels); c++) {
            if (pixelValues[c]! < min) min = pixelValues[c]!;
            if (pixelValues[c]! > max) max = pixelValues[c]!;
          }
          if (counts) {
            const pixel = target / channels;
            if (!counts[pixel]) for (let c = 0; c < channels; c++) values[target + c] = 0;
            for (let c = 0; c < channels; c++) values[target + c]! += pixelValues[c]!;
            counts[pixel]!++;
          } else if (factor === 1 || Number.isNaN(values[target]!))
            for (let c = 0; c < channels; c++) values[target + c] = pixelValues[c]!;
        }
      }
    }
  if (counts)
    for (let pixel = 0; pixel < counts.length; pixel++)
      if (counts[pixel])
        for (let c = 0; c < channels; c++) values[pixel * channels + c]! /= counts[pixel]!;

  // 8-bit, palette and JPEG colour are shown as stored; deeper data gets a display range.
  const stretch = !palette && photometric !== 6 && (bits !== 8 || format !== "uint");
  const colour = alpha ? channels - 1 : channels;
  const channel = rgb ? 0 : layout.samplesAsChannels > 1 ? read[0]! : planeChannel(plane, layout);
  let display: readonly [number, number] | null = null;
  if (stretch && Number.isFinite(min)) {
    const [low, high] =
      request.heldDisplay?.(channel) ??
      layout.displayHint ??
      percentileRange(values, channels, colour, min, max, format !== "float" && max - min < 65_536);
    display = [low, high > low ? high : low + 1];
  }
  const orient = orientation(
    Number((await directory.loadValue("Orientation")) ?? 1),
    outWidth,
    outHeight,
  );
  const rgba = new Uint8ClampedArray(outWidth * outHeight * 4);
  const alphaScale = 255 / alphaMax;
  const [low, high] = display ?? [0, 255];
  const span = high - low;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const source = (y * outWidth + x) * channels;
      const first = values[source]!;
      if (Number.isNaN(first)) continue;
      const target = orient.at(x, y) * 4;
      if (palette) {
        const size = palette.length / 3;
        for (let c = 0; c < 3; c++) rgba[target + c] = palette[c * size + first]! / 257;
      } else if (photometric === 6) {
        const cb = values[source + 1]! - 128;
        const cr = values[source + 2]! - 128;
        rgba[target] = first + 1.402 * cr;
        rgba[target + 1] = first - 0.34414 * cb - 0.71414 * cr;
        rgba[target + 2] = first + 1.772 * cb;
      } else {
        for (let c = 0; c < 3; c++) {
          const scaled = ((values[source + (rgb ? c : 0)]! - low) / span) * 255;
          rgba[target + c] = photometric === 0 ? 255 - scaled : scaled;
        }
      }
      rgba[target + 3] = alpha ? values[source + channels - 1]! * alphaScale : 255;
    }
  }
  const swap = orient.swap;
  return {
    rgba,
    width: swap ? outHeight : outWidth,
    height: swap ? outWidth : outHeight,
    info: {
      width: swap ? height : width,
      height: swap ? width : height,
      plane,
      planes,
      axes:
        layout.samplesAsChannels > 1
          ? [
              { name: "C", size: layout.samplesAsChannels },
              ...layout.axes.filter((axis) => axis.name !== "C"),
            ]
          : layout.axes,
      channel,
      bits,
      format,
      range: Number.isFinite(min) ? [min, max] : null,
      display,
      scale: 1 / factor,
    },
  };
}

function planeChannel(plane: number, layout: Layout) {
  return axisIndices(plane, layout.axes).find(({ axis }) => axis.name === "C")?.index ?? 0;
}
