export interface TiffFixturePage {
  readonly width: number;
  readonly height: number;
  readonly bits: 8 | 16 | 32 | 64;
  /** 1 unsigned, 2 signed, 3 float. */
  readonly format?: 1 | 2 | 3;
  readonly samples?: number;
  readonly photometric?: number;
  readonly data: ArrayLike<number>;
  readonly description?: string;
  readonly subfileType?: number;
  readonly orientation?: number;
  readonly tile?: number;
  /** Tile height when it differs from the tile width. */
  readonly tileHeight?: number;
  readonly jpegTables?: Uint8Array;
  /** 2 stores each sample in its own blocks; only meaningful with `rawBlocks`. */
  readonly planar?: 1 | 2;
  readonly rowsPerStrip?: number;
  readonly deflate?: boolean;
  readonly colorMap?: ArrayLike<number>;
  /** ExtraSamples values: 0 unspecified, 1 premultiplied alpha, 2 straight alpha. */
  readonly extraSamples?: readonly number[];
  /** Stores these bytes as the image's blocks under this compression code, ignoring `data`. */
  readonly rawBlocks?: { readonly compression: number; readonly blocks: readonly Uint8Array[] };
}

type Entry = { tag: number; type: number; values: number[] | Uint8Array };

async function deflate(bytes: Uint8Array<ArrayBuffer>) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function encode(page: TiffFixturePage, values: ArrayLike<number>) {
  const bytes = page.bits / 8;
  const out = new DataView(new ArrayBuffer(values.length * bytes));
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (page.bits === 8) out.setUint8(index, value);
    else if (page.bits === 16 && page.format === 2) out.setInt16(index * 2, value, true);
    else if (page.bits === 16) out.setUint16(index * 2, value, true);
    else if (page.bits === 64) out.setFloat64(index * 8, value, true);
    else if (page.format === 3) out.setFloat32(index * 4, value, true);
    else if (page.format === 2) out.setInt32(index * 4, value, true);
    else out.setUint32(index * 4, value, true);
  }
  return new Uint8Array(out.buffer);
}

async function blocks(page: TiffFixturePage): Promise<readonly Uint8Array[]> {
  if (page.rawBlocks) return page.rawBlocks.blocks;
  const samples = page.samples ?? 1;
  const pieces: number[][] = [];
  if (page.tile) {
    const tileHeight = page.tileHeight ?? page.tile;
    for (let ty = 0; ty < page.height; ty += tileHeight)
      for (let tx = 0; tx < page.width; tx += page.tile) {
        const piece: number[] = [];
        for (let y = ty; y < ty + tileHeight; y++)
          for (let x = tx; x < tx + page.tile; x++)
            for (let s = 0; s < samples; s++)
              piece.push(
                x < page.width && y < page.height
                  ? page.data[(y * page.width + x) * samples + s]!
                  : 0,
              );
        pieces.push(piece);
      }
  } else {
    const rows = page.rowsPerStrip ?? page.height;
    for (let y = 0; y < page.height; y += rows)
      pieces.push(
        Array.from(page.data).slice(
          y * page.width * samples,
          Math.min(page.height, y + rows) * page.width * samples,
        ),
      );
  }
  return Promise.all(
    pieces.map((piece) => (page.deflate ? deflate(encode(page, piece)) : encode(page, piece))),
  );
}

/** Writes a little-endian TIFF (or BigTIFF) with one IFD per page. */
export async function tiffFixture(
  pages: readonly TiffFixturePage[],
  options: { readonly bigTiff?: boolean } = {},
) {
  const big = options.bigTiff ?? false;
  const chunks: Uint8Array[] = [];
  let size = big ? 16 : 8;
  const append = (bytes: Uint8Array) => {
    const offset = size;
    chunks.push(bytes);
    size += bytes.length;
    if (size % 2) {
      chunks.push(new Uint8Array(1));
      size++;
    }
    return offset;
  };
  const ifdOffsets: number[] = [];
  const patches: { at: number; value: number }[] = [];
  for (const page of pages) {
    const samples = page.samples ?? 1;
    const data = await blocks(page);
    const offsets = data.map(append);
    const entries: Entry[] = [
      { tag: 256, type: 4, values: [page.width] },
      { tag: 257, type: 4, values: [page.height] },
      { tag: 258, type: 3, values: Array(samples).fill(page.bits) },
      {
        tag: 259,
        type: 3,
        values: [page.rawBlocks?.compression ?? (page.deflate ? 8 : 1)],
      },
      { tag: 262, type: 3, values: [page.photometric ?? (samples >= 3 ? 2 : 1)] },
      { tag: 277, type: 3, values: [samples] },
      { tag: 284, type: 3, values: [page.planar ?? 1] },
      { tag: 339, type: 3, values: Array(samples).fill(page.format ?? 1) },
      ...(page.tile
        ? [
            { tag: 322, type: 4, values: [page.tile] },
            { tag: 323, type: 4, values: [page.tileHeight ?? page.tile] },
            { tag: 324, type: big ? 16 : 4, values: offsets },
            { tag: 325, type: 4, values: data.map((block) => block.length) },
          ]
        : [
            { tag: 273, type: big ? 16 : 4, values: offsets },
            { tag: 278, type: 4, values: [page.rowsPerStrip ?? page.height] },
            { tag: 279, type: 4, values: data.map((block) => block.length) },
          ]),
      ...(page.subfileType ? [{ tag: 254, type: 4, values: [page.subfileType] }] : []),
      ...(page.orientation ? [{ tag: 274, type: 3, values: [page.orientation] }] : []),
      ...(page.colorMap ? [{ tag: 320, type: 3, values: Array.from(page.colorMap) }] : []),
      ...(page.extraSamples ? [{ tag: 338, type: 3, values: [...page.extraSamples] }] : []),
      ...(page.jpegTables ? [{ tag: 347, type: 7, values: page.jpegTables }] : []),
      ...(page.description
        ? [{ tag: 270, type: 2, values: new TextEncoder().encode(`${page.description}\0`) }]
        : []),
    ].toSorted((left, right) => left.tag - right.tag);
    const width = (type: number) => ({ 2: 1, 3: 2, 4: 4, 7: 1, 16: 8 })[type]!;
    const inline = big ? 8 : 4;
    const external = new Map<number, number>();
    for (const entry of entries) {
      const length = entry.values.length * width(entry.type);
      if (length <= inline) continue;
      const bytes = new DataView(new ArrayBuffer(length));
      entry.values.forEach((value, index) =>
        write(bytes, entry.type, index * width(entry.type), value),
      );
      external.set(entry.tag, append(new Uint8Array(bytes.buffer)));
    }
    const entrySize = big ? 20 : 12;
    const ifd = new DataView(
      new ArrayBuffer((big ? 8 : 2) + entries.length * entrySize + (big ? 8 : 4)),
    );
    if (big) ifd.setBigUint64(0, BigInt(entries.length), true);
    else ifd.setUint16(0, entries.length, true);
    entries.forEach((entry, index) => {
      const at = (big ? 8 : 2) + index * entrySize;
      ifd.setUint16(at, entry.tag, true);
      ifd.setUint16(at + 2, entry.type, true);
      if (big) ifd.setBigUint64(at + 4, BigInt(entry.values.length), true);
      else ifd.setUint32(at + 4, entry.values.length, true);
      const valueAt = at + (big ? 12 : 8);
      const offset = external.get(entry.tag);
      if (offset !== undefined) write(ifd, big ? 16 : 4, valueAt, offset);
      else
        entry.values.forEach((value, i) =>
          write(ifd, entry.type, valueAt + i * width(entry.type), value),
        );
    });
    const ifdOffset = append(new Uint8Array(ifd.buffer));
    ifdOffsets.push(ifdOffset);
    patches.push({ at: ifdOffset + ifd.byteLength - (big ? 8 : 4), value: 0 });
  }
  const file = new Uint8Array(size);
  const view = new DataView(file.buffer);
  let at = big ? 16 : 8;
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.length;
  }
  view.setUint16(0, 0x4949);
  view.setUint16(2, big ? 43 : 42, true);
  if (big) {
    view.setUint16(4, 8, true);
    view.setBigUint64(8, BigInt(ifdOffsets[0]!), true);
  } else view.setUint32(4, ifdOffsets[0]!, true);
  // Chain each IFD to the next.
  patches.forEach((patch, index) => {
    const next = ifdOffsets[index + 1] ?? 0;
    if (big) view.setBigUint64(patch.at, BigInt(next), true);
    else view.setUint32(patch.at, next, true);
  });
  return file.buffer;
}

function write(view: DataView, type: number, at: number, value: number) {
  if (type === 2 || type === 7) view.setUint8(at, value);
  else if (type === 3) view.setUint16(at, value, true);
  else if (type === 4) view.setUint32(at, value, true);
  else view.setBigUint64(at, BigInt(value), true);
}
