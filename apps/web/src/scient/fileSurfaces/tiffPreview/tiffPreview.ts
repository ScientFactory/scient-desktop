import { GeoTIFF, type GeoTIFFImage } from "geotiff";

import { checkTiffLayout, LAYOUT_INVALID, LAYOUT_UNSUPPORTED, type TiffLayout } from "./tiffLayout";
import {
  compressionName,
  tiffBlockDecoder,
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
// Peak memory stays under about 400 MiB. Decoding: values ≤128 MiB, one window ≤64 MiB counting
// packed, unpacked and interleaved copies, compressed input ≤1.5× packed (≤96 MiB): ≤288 MiB.
// Then values plus 128 MiB of RGBA at 32 MP: 256 MiB. PNG encoding holds the RGBA, the canvas and
// the PNG: about 390 MiB, the peak.
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

// geotiff keeps every directory it walks past, so each one is opened on its own.
async function openDirectory(tiff: GeoTIFF, offset: number) {
  const image = await new GeoTIFF(tiff.source, tiff.littleEndian, tiff.bigTiff, offset).getImage(0);
  // TIFF 6.0 defaults BitsPerSample to 1, as in bilevel files; geotiff has no default of its own.
  const directory = image.getFileDirectory();
  if (!directory.hasTag("BitsPerSample"))
    directory.actualizedFields.set(258, Array<number>(image.getSamplesPerPixel()).fill(1));
  return image;
}

async function describeLayout(first: GeoTIFFImage, walked: TiffLayout): Promise<Layout> {
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
  if (parsed && parsed.count >= 1 && parsed.count <= walked.offsets.length)
    return { pages: null, pageCount: parsed.count, samplesAsChannels, ...parsed };
  // Skip reduced-resolution and mask images.
  const pages = walked.subfileTypes.flatMap((type, index) => (type & 0b101 ? [] : [index]));
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

// Assembles a window from decoded blocks, which geotiff unpacks to 8, 16 or 32 bits per sample
// except 24-bit samples, which it leaves as three bytes.
async function readOddWidth(
  image: GeoTIFFImage,
  [left, top, right, bottom]: readonly [number, number, number, number],
  read: readonly number[],
  signal: AbortSignal | undefined,
): Promise<Band> {
  const decoder = await tiffBlockDecoder(image.getFileDirectory());
  const bits = image.getBitsPerSample(0);
  const planar = image.planarConfiguration === 2;
  const stride = planar ? 1 : image.getSamplesPerPixel();
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const span = right - left;
  const out = new Float32Array((bottom - top) * span * read.length);
  for (let tileY = Math.floor(top / tileHeight); tileY * tileHeight < bottom; tileY++)
    for (let tileX = Math.floor(left / tileWidth); tileX * tileWidth < right; tileX++)
      for (let c = 0; c < read.length; c++) {
        if (!planar && c > 0) break;
        const block = await image.getTileOrStrip(
          tileX,
          tileY,
          planar ? read[c]! : 0,
          decoder,
          signal,
        );
        const bytes = new Uint8Array(block.data);
        const unpacked =
          bits === 24
            ? null
            : bits <= 8
              ? bytes
              : bits <= 16
                ? new Uint16Array(block.data)
                : new Uint32Array(block.data);
        const sample = (index: number) => {
          if (unpacked) return unpacked[index]!;
          const at = index * 3;
          return image.littleEndian
            ? bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
            : (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!;
        };
        const y0 = Math.max(top, tileY * tileHeight);
        const y1 = Math.min(bottom, (tileY + 1) * tileHeight);
        const x0 = Math.max(left, tileX * tileWidth);
        const x1 = Math.min(right, (tileX + 1) * tileWidth);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const pixel = (y - tileY * tileHeight) * tileWidth + (x - tileX * tileWidth);
            const target = ((y - top) * span + (x - left)) * read.length;
            if (planar) out[target + c] = sample(pixel);
            else
              for (let r = 0; r < read.length; r++)
                out[target + r] = sample(pixel * stride + read[r]!);
          }
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
  const walked = await checkTiffLayout(tiff).catch((cause: unknown) => {
    if (cause instanceof Error && [LAYOUT_INVALID, LAYOUT_UNSUPPORTED].includes(cause.message))
      throw tiffPreviewError(cause.message);
    return asMetadataError(cause);
  });
  const first = await openDirectory(tiff, walked.offsets[0]!).catch(asMetadataError);
  const layout = await describeLayout(first, walked).catch(asMetadataError);
  const planes = layout.pageCount * layout.samplesAsChannels;
  if (planes < 1) throw tiffPreviewError("This TIFF has no readable image.");
  const plane = Math.min(Math.max(0, Math.trunc(request.plane)), planes - 1);
  const page = Math.floor(plane / layout.samplesAsChannels);
  const image = await openDirectory(
    tiff,
    walked.offsets[layout.pages ? layout.pages[page]! : page]!,
  ).catch(asMetadataError);
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
  const allBits = Array.from(
    ((await directory.loadValue("BitsPerSample")) as ArrayLike<number> | undefined) ?? [bits],
    Number,
  );
  // geotiff places unsigned samples of other widths at the wrong offsets, so those are read by block;
  // above 24 bits a sample can span five bytes, and it unpacks every sample at the first one's width.
  const unsupportedWidth =
    format === "int"
      ? ![8, 16, 32].includes(bits)
      : format === "float"
        ? ![16, 32, 64].includes(bits)
        : bits > 24 && bits !== 32;
  if (unsupportedWidth || allBits.some((sampleBits) => sampleBits !== bits))
    throw tiffPreviewError("This TIFF's sample width isn't supported for preview.");
  // Bits stored lowest first (FillOrder 2) are a fax convention geotiff does not reverse.
  if (Number((await directory.loadValue("FillOrder")) ?? 1) === 2)
    throw tiffPreviewError("This TIFF's bit order (FillOrder 2) isn't supported for preview.");
  const oddWidth = format === "uint" && ![8, 16, 32].includes(bits);
  const rawRows =
    compression === 1 &&
    !image.isTiled &&
    image.planarConfiguration === 1 &&
    [8, 16, 32, 64].includes(bits);
  const blockBits =
    image.planarConfiguration === 2 ? bits : allBits.reduce((sum, value) => sum + value, 0);
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const tilesAcross = Math.ceil(width / tileWidth);
  const blockDecoded = Math.ceil((tileWidth * blockBits) / 8) * tileHeight;
  // geotiff widens packed samples (1-bit, 12-bit, 24-bit, float16) into a second, unpacked copy.
  const blockBitsList = image.planarConfiguration === 2 ? [bits] : allBits;
  const unpacked = blockBitsList.some((sampleBits) => ![8, 16, 32, 64].includes(sampleBits))
    ? tileWidth *
      tileHeight *
      blockBitsList.reduce((sum, sampleBits) => sum + unpackedBytes(sampleBits, format), 0)
    : 0;
  const blockMemory = blockDecoded + unpacked;
  // Integers wider than 24 bits and 64-bit floats lose precision in Float32, so they keep doubles.
  const precise = format === "float" ? bits > 32 : bits > 24;
  // geotiff's JPEG decoder needs several times a tile's pixels while it works.
  const jpegWorking =
    compression === 7
      ? jpegTileWorkingBytes(tileWidth, tileHeight, image.planarConfiguration === 2 ? 1 : samples)
      : 0;
  if (jpegWorking > JPEG_TILE_BYTES) throw tiffPreviewError(JPEG_TOO_LARGE);
  // A block, with every sample read from it, is decoded whole whatever the window budget, and its
  // pixels are copied once more into the window's interleaved values.
  const blockSamples = image.planarConfiguration === 2 ? channels : 1;
  const windowBytes = rawRows || oddWidth ? (precise ? 8 : 4) : unpackedBytes(bits, format);
  const blockInFlight =
    Math.max(blockMemory, jpegWorking) * blockSamples +
    tileWidth * tileHeight * channels * windowBytes;
  // Uncompressed rows are read whole: the fetched bytes plus their converted values.
  const rowInFlight = width * (image.getBytesPerPixel() + channels * (precise ? 8 : 4));
  if (rawRows ? rowInFlight > TILE_BYTES : blockInFlight > TILE_BYTES)
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

  // Values keep the source's own integer type when every output pixel is one source pixel.
  const floatBytes = precise ? 8 : 4;
  const nativeBytes =
    format === "float" || associated || bits > 32 ? floatBytes : unpackedBytes(bits, format);
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
      : integerArray(nativeBytes, format === "int", length);
  const counts = factor > 1 && !palette ? new Uint16Array(outWidth * outHeight) : null;
  // geotiff decodes every block of a window at once, so windows hold a bounded number of blocks.
  const bandBytes = request.bandBytes ?? BAND_BYTES;
  const blocksPerBand = Math.max(1, Math.floor(bandBytes / blockInFlight));
  let bandRows = tileHeight;
  let bandColumns = width;
  if (rawRows) bandRows = Math.max(1, Math.floor(bandBytes / rowInFlight));
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
        : oddWidth
          ? await readOddWidth(image, [left, top, right, bottom], read, signal)
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

/** Bytes per sample in the arrays geotiff produces, which round packed widths up. */
function unpackedBytes(bits: number, format: TiffPreviewInfo["format"]) {
  if (format === "float") return bits > 32 ? 8 : 4;
  return bits <= 8 ? 1 : bits <= 16 ? 2 : bits <= 32 ? 4 : 8;
}

function integerArray(bytes: number, signed: boolean, length: number) {
  if (bytes === 1) return signed ? new Int8Array(length) : new Uint8Array(length);
  if (bytes === 2) return signed ? new Int16Array(length) : new Uint16Array(length);
  return signed ? new Int32Array(length) : new Uint32Array(length);
}
