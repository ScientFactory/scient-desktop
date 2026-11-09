import { addDecoder, BaseDecoder, getDecoder, type ImageFileDirectory } from "geotiff";

type BlockParameters = BaseDecoder["parameters"];

const OVERSIZED_BLOCK = "This TIFF has an oversized compressed block.";

function blockBytes(parameters: BlockParameters) {
  const bits =
    typeof parameters.bitsPerSample === "number"
      ? [parameters.bitsPerSample]
      : Array.from(parameters.bitsPerSample);
  const pixelBits =
    parameters.planarConfiguration === 2 ? bits[0]! : bits.reduce((sum, value) => sum + value, 0);
  return Math.ceil((parameters.tileWidth * pixelBits) / 8) * parameters.tileHeight;
}

// Output never exceeds the block's declared size, so a crafted strip cannot exhaust memory.
export function decodeLzw(input: Uint8Array, limit: number) {
  const output = new Uint8Array(limit);
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let code = 0; code < 256; code++) {
    suffix[code] = code;
    lengths[code] = 1;
  }
  let bits = 9;
  let next = 258;
  let previous = -1;
  let bit = 0;
  let written = 0;
  const emit = (code: number) => {
    const length = lengths[code]!;
    if (written + length > limit) throw new Error(OVERSIZED_BLOCK);
    for (let at = written + length - 1, entry = code; at >= written; at--, entry = prefix[entry]!)
      output[at] = suffix[entry]!;
    written += length;
    return output[written - length]!;
  };
  while (bit + bits <= input.length * 8) {
    let code = 0;
    for (let index = 0; index < bits; index++, bit++)
      code = (code << 1) | ((input[bit >> 3]! >> (7 - (bit & 7))) & 1);
    if (code === 257) break;
    if (code === 256) {
      bits = 9;
      next = 258;
      previous = -1;
      continue;
    }
    let first: number;
    if (code < 256 || (code >= 258 && code < next)) first = emit(code);
    else if (code === next && previous >= 0) {
      first = emit(previous);
      if (written + 1 > limit) throw new Error(OVERSIZED_BLOCK);
      output[written++] = first;
    } else throw new Error("This TIFF has invalid LZW data.");
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      lengths[next] = lengths[previous]! + 1;
      next++;
      if (next + 1 >= 1 << bits && bits < 12) bits++;
    }
    previous = code;
  }
  return output.buffer;
}

export async function inflateBounded(input: Uint8Array<ArrayBuffer>, limit: number) {
  const output = new Uint8Array(limit);
  const reader = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  let written = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (written + value.length > limit) throw new Error(OVERSIZED_BLOCK);
      output.set(value, written);
      written += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return output.buffer;
}

// Packed rows can legitimately be a little larger than the raw block; anything far larger is not a block.
export function maxCompressedBytes(decodedBytes: number) {
  return decodedBytes * 2 + 64 * 1024;
}

function checkCompressed(buffer: ArrayBufferLike, parameters: BlockParameters) {
  if (buffer.byteLength > maxCompressedBytes(blockBytes(parameters)))
    throw new Error(OVERSIZED_BLOCK);
}

function decodePackBits(input: Uint8Array, limit: number) {
  const output = new Uint8Array(limit);
  let written = 0;
  for (let at = 0; at < input.length;) {
    const header = (input[at++]! << 24) >> 24;
    if (header >= 0) {
      const length = header + 1;
      if (written + length > limit || at + length > input.length) throw new Error(OVERSIZED_BLOCK);
      output.set(input.subarray(at, at + length), written);
      written += length;
      at += length;
    } else if (header !== -128) {
      const length = 1 - header;
      if (written + length > limit || at >= input.length) throw new Error(OVERSIZED_BLOCK);
      output.fill(input[at++]!, written, written + length);
      written += length;
    }
  }
  return output.buffer;
}

/** Total decompressed size the Zstandard frames declare, or null when a frame leaves it out. */
export function zstdContentSize(input: Uint8Array) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let at = 0;
  let total = 0;
  while (at < input.length) {
    if (at + 8 > input.length) return null;
    const magic = view.getUint32(at, true);
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      at += 8 + view.getUint32(at + 4, true);
      continue;
    }
    if (magic !== 0xfd2fb528) return null;
    const descriptor = input[at + 4]!;
    const single = (descriptor >> 5) & 1;
    const sizeBytes = [single, 2, 4, 8][descriptor >> 6]!;
    at += 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]!;
    if (!sizeBytes || at + sizeBytes > input.length) return null;
    let size = 0;
    for (let index = sizeBytes - 1; index >= 0; index--) size = size * 256 + input[at + index]!;
    total += sizeBytes === 2 ? size + 256 : size;
    at += sizeBytes;
    for (let last = 0; !last;) {
      if (at + 3 > input.length) return null;
      const header = input[at]! | (input[at + 1]! << 8) | (input[at + 2]! << 16);
      const type = (header >> 1) & 3;
      if (type === 3) return null;
      last = header & 1;
      at += 3 + (type === 1 ? 1 : header >>> 3);
    }
    if ((descriptor >> 2) & 1) at += 4;
  }
  return total;
}

/** Frame width and height from a JPEG's start-of-frame marker, or null when there is none. */
export function jpegFrameSize(input: Uint8Array) {
  if (input[0] !== 0xff || input[1] !== 0xd8) return null;
  for (let at = 2; at + 4 <= input.length;) {
    if (input[at] !== 0xff) return null;
    const marker = input[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const length = (input[at + 2]! << 8) | input[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (at + 9 > input.length) return null;
      return {
        height: (input[at + 5]! << 8) | input[at + 6]!,
        width: (input[at + 7]! << 8) | input[at + 8]!,
      };
    }
    at += 2 + length;
  }
  return null;
}

async function blockParameters(directory: ImageFileDirectory): Promise<BlockParameters> {
  const tiled = !directory.hasTag("StripOffsets");
  const height = Number(await directory.loadValue("ImageLength"));
  return {
    tileWidth: Number(await directory.loadValue(tiled ? "TileWidth" : "ImageWidth")),
    // Writers often store RowsPerStrip as 2^32 - 1 for a single strip.
    tileHeight: tiled
      ? Number(await directory.loadValue("TileLength"))
      : Math.min(Number((await directory.loadValue("RowsPerStrip")) || height), height),
    planarConfiguration: Number((await directory.loadValue("PlanarConfiguration")) ?? 1),
    bitsPerSample: (await directory.loadValue("BitsPerSample")) ?? 8,
    predictor: Number((await directory.loadValue("Predictor")) || 1),
  };
}

class BoundedRawDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike) {
    checkCompressed(buffer, this.parameters);
    return buffer;
  }
}

class BoundedLzwDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike) {
    checkCompressed(buffer, this.parameters);
    return decodeLzw(new Uint8Array(buffer), blockBytes(this.parameters));
  }
}

class BoundedDeflateDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike) {
    checkCompressed(buffer, this.parameters);
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(new Uint8Array(buffer));
    return inflateBounded(bytes, blockBytes(this.parameters));
  }
}

class BoundedPackBitsDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike) {
    checkCompressed(buffer, this.parameters);
    return decodePackBits(new Uint8Array(buffer), blockBytes(this.parameters));
  }
}

type Guard = (bytes: Uint8Array, parameters: BlockParameters) => void;

const guardZstd: Guard = (bytes, parameters) => {
  const size = zstdContentSize(bytes);
  if (size === null || size > blockBytes(parameters)) throw new Error(OVERSIZED_BLOCK);
};

const guardJpeg: Guard = (bytes, parameters) => {
  const frame = jpegFrameSize(bytes);
  // A JPEG block is encoded at the block's size, padded to at most one 16-pixel MCU.
  if (
    !frame ||
    frame.width > Math.ceil(parameters.tileWidth / 16) * 16 ||
    frame.height > Math.ceil(parameters.tileHeight / 16) * 16
  )
    throw new Error(OVERSIZED_BLOCK);
};

// geotiff allocates these from sizes inside the block, so each block is checked before decoding.
const GUARDED: ReadonlyMap<number, Guard> = new Map([
  [7, guardJpeg],
  [50000, guardZstd],
]);

/** Compression codes the preview decodes, each with bounded output. */
export const PREVIEW_COMPRESSIONS: ReadonlySet<number> = new Set([1, 5, 7, 8, 32773, 32946, 50000]);

const COMPRESSION_NAMES: ReadonlyMap<number, string> = new Map([
  [2, "CCITT"],
  [3, "CCITT Group 3"],
  [4, "CCITT Group 4"],
  [6, "old-style JPEG"],
  [34712, "JPEG 2000"],
  [34887, "LERC"],
  [50001, "WebP"],
]);

export function compressionName(code: number) {
  return COMPRESSION_NAMES.get(code) ?? String(code);
}

let registered = false;
const guarded = new Set<number>();

export function registerBoundedTiffDecoders() {
  if (registered) return;
  registered = true;
  addDecoder([undefined, 1], async () => BoundedRawDecoder, blockParameters, false);
  addDecoder(5, async () => BoundedLzwDecoder, blockParameters, false);
  addDecoder([8, 32946], async () => BoundedDeflateDecoder, blockParameters, false);
  addDecoder(32773, async () => BoundedPackBitsDecoder, blockParameters, false);
}

/** Wraps geotiff's own decoder for a guarded code the first time a file needs it. */
export function guardTiffDecoder(compression: number) {
  const guard = GUARDED.get(compression);
  if (!guard || guarded.has(compression)) return;
  guarded.add(compression);
  // getDecoder looks the code up synchronously, so this captures geotiff's decoder before the override.
  const original = getDecoder(compression, {
    tileWidth: 1,
    tileHeight: 1,
    predictor: 1,
    bitsPerSample: 8,
    planarConfiguration: 1,
  }).then((decoder) => decoder.constructor as typeof BaseDecoder);
  addDecoder(
    compression,
    async () => {
      const Original = await original;
      return class GuardedDecoder extends Original {
        override decodeBlock(buffer: ArrayBufferLike) {
          checkCompressed(buffer, this.parameters);
          guard(new Uint8Array(buffer), this.parameters);
          return super.decodeBlock(buffer);
        }
      };
    },
    async (directory) => ({
      ...(await blockParameters(directory)),
      ...(compression === 7 ? { JPEGTables: await directory.loadValue("JPEGTables") } : {}),
    }),
    false,
  );
}
