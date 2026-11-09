import type { GeoTIFF, GeoTIFFImage } from "geotiff";

const MAX_OUTPUT_PIXELS = 32_000_000;
const MAX_OUTPUT_SIDE = 16_384;
const MAX_SOURCE_SIDE = 1 << 20;
const MAX_SOURCE_PIXELS = 256_000_000;
const MAX_BLOCK_BYTES = 128 * 1024 * 1024;
const BAND_BYTES = 16 * 1024 * 1024;
const MAX_WALKED_PAGES = 10_000;
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

// Raw, LZW, JPEG, Deflate, PackBits, LERC, Zstd and WebP: what geotiff can decode.
const SUPPORTED_COMPRESSIONS = new Set([1, 5, 7, 8, 32773, 32946, 34887, 50000, 50001]);

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

async function describeLayout(tiff: GeoTIFF, first: GeoTIFFImage): Promise<Layout> {
  const directory = first.getFileDirectory();
  const description = directory.hasTag("ImageDescription")
    ? String(await directory.loadValue("ImageDescription"))
    : undefined;
  const photometric = Number(directory.getValue("PhotometricInterpretation") ?? 1);
  const extra = directory.hasTag("ExtraSamples") ? 1 : 0;
  const colour = first.getSamplesPerPixel() - extra;
  const rgb = (photometric === 2 || photometric === 6) && colour >= 3;
  const samplesAsChannels = !rgb && photometric !== 3 && colour > 1 ? colour : 1;
  const parsed = parseDescription(description);
  if (parsed && parsed.count >= 1) {
    // Multi-file OME and ImageJ's >4 GB stacks describe planes this file does not hold.
    const present = await tiff.getImage(parsed.count - 1).then(
      () => true,
      () => false,
    );
    if (present) return { pages: null, pageCount: parsed.count, samplesAsChannels, ...parsed };
  }
  const pages: number[] = [];
  for (let index = 0; index < MAX_WALKED_PAGES; index++) {
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

function orientation(value: number, width: number, height: number) {
  const swap = value >= 5;
  const outWidth = swap ? height : width;
  const flipX = [2, 3, 6, 7].includes(value);
  const flipY = [3, 4, 7, 8].includes(value);
  return {
    swap,
    at: (x: number, y: number) => {
      const fx = flipX ? width - 1 - x : x;
      const fy = flipY ? height - 1 - y : y;
      return swap ? fx * outWidth + fy : fy * outWidth + fx;
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
  signal: AbortSignal | undefined,
): Promise<Band> {
  const width = image.getWidth();
  const samples = image.getSamplesPerPixel();
  const bytes = image.getBitsPerSample(0) / 8;
  const rowBytes = width * samples * bytes;
  const rowsPerStrip = image.getTileHeight();
  const directory = image.getFileDirectory();
  const readers = read.map((sample) => image.getReaderForSample(sample));
  const out = new Float32Array((bottom - top) * width * read.length);
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
  values: Float32Array,
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
    readonly signal?: AbortSignal;
  },
): Promise<TiffPlane> {
  const { signal } = request;
  const first = await tiff.getImage(0).catch(asMetadataError);
  const layout = await describeLayout(tiff, first).catch(asMetadataError);
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
  if (!SUPPORTED_COMPRESSIONS.has(compression))
    throw tiffPreviewError(`This TIFF's compression (${compression}) is not supported.`);
  if (![0, 1, 2, 3].includes(photometric) && !(photometric === 6 && compression === 7))
    throw tiffPreviewError("This TIFF color format is not supported.");
  const samples = image.getSamplesPerPixel();
  const bits = image.getBitsPerSample(0);
  const sampleFormat = image.getSampleFormat(0);
  const format = sampleFormat === 3 ? "float" : sampleFormat === 2 ? "int" : "uint";
  const colorMap = photometric === 3 ? await directory.loadValue("ColorMap") : undefined;
  const palette = colorMap ? Array.from(colorMap, Number) : null;
  if (photometric === 3 && !palette) throw tiffPreviewError("This TIFF's palette is missing.");
  const rgb = !palette && layout.samplesAsChannels === 1 && samples >= 3;
  const alpha = rgb && samples >= 4;
  const read = rgb ? (alpha ? [0, 1, 2, 3] : [0, 1, 2]) : [plane % layout.samplesAsChannels];
  const channels = read.length;
  const rawRows =
    compression === 1 && !image.isTiled && image.planarConfiguration === 1 && bits % 8 === 0;
  if (
    !rawRows &&
    image.getTileWidth() * image.getTileHeight() * image.getBytesPerPixel() > MAX_BLOCK_BYTES
  )
    throw tiffPreviewError("This TIFF stores its image in blocks too large to preview.");

  const budget = request.maxOutputPixels ?? MAX_OUTPUT_PIXELS;
  const factor = Math.max(
    1,
    Math.ceil(Math.sqrt((width * height) / budget)),
    Math.ceil(Math.max(width, height) / MAX_OUTPUT_SIDE),
  );
  const outWidth = Math.ceil(width / factor);
  const outHeight = Math.ceil(height / factor);
  const values = new Float32Array(outWidth * outHeight * channels).fill(Number.NaN);
  const counts = factor > 1 && !palette ? new Uint16Array(outWidth * outHeight) : null;
  const blockRows = rawRows ? 1 : image.getTileHeight();
  const rowBytes = width * image.getBytesPerPixel();
  const bandRows = Math.max(
    blockRows,
    Math.floor(BAND_BYTES / rowBytes / blockRows) * blockRows,
    factor,
  );
  let min = Infinity;
  let max = -Infinity;
  for (let top = 0; top < height; top += bandRows) {
    signal?.throwIfAborted();
    const bottom = Math.min(height, top + bandRows);
    const band: Band = rawRows
      ? await readRawRows(image, top, bottom, read, signal)
      : await image.readRasters({
          window: [0, top, width, bottom],
          samples: [...read],
          interleave: true,
          ...(signal ? { signal } : {}),
        });
    for (let y = top; y < bottom; y++) {
      const outRow = Math.floor(y / factor) * outWidth;
      for (let x = 0; x < width; x++) {
        const source = ((y - top) * width + x) * channels;
        const target = (outRow + Math.floor(x / factor)) * channels;
        let finite = true;
        for (let c = 0; c < channels; c++) {
          const value = band[source + c]!;
          if (!Number.isFinite(value)) finite = false;
          else if (!(alpha && c === 3)) {
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
        if (!finite) continue;
        if (counts) {
          const pixel = target / channels;
          if (!counts[pixel]) for (let c = 0; c < channels; c++) values[target + c] = 0;
          for (let c = 0; c < channels; c++) values[target + c]! += band[source + c]!;
          counts[pixel]!++;
        } else if (Number.isNaN(values[target]!))
          for (let c = 0; c < channels; c++) values[target + c] = band[source + c]!;
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
  const alphaScale = format === "float" ? 255 : 255 / (2 ** bits - 1);
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
      rgba[target + 3] = alpha ? values[source + 3]! * alphaScale : 255;
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
