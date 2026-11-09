import { addDecoder, BaseDecoder, type ImageFileDirectory } from "geotiff";

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

class BoundedLzwDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike) {
    return decodeLzw(new Uint8Array(buffer), blockBytes(this.parameters));
  }
}

class BoundedDeflateDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike) {
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(new Uint8Array(buffer));
    return inflateBounded(bytes, blockBytes(this.parameters));
  }
}

let registered = false;

export function registerBoundedTiffDecoders() {
  if (registered) return;
  registered = true;
  addDecoder(5, async () => BoundedLzwDecoder, blockParameters, false);
  addDecoder([8, 32946], async () => BoundedDeflateDecoder, blockParameters, false);
}
