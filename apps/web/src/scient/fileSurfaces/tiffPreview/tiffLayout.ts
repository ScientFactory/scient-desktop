import type { GeoTIFF } from "geotiff";

const MAX_TIFF_DIRECTORIES = 10_000;
const MAX_ENTRIES = 1_024;
const MAX_BLOCKS = 1 << 20;
const MAX_TAG_BYTES = 16 * 1024 * 1024;
// Metadata arrays geotiff may hold across the whole file.
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
export const LAYOUT_UNSUPPORTED = "This TIFF's layout isn't supported for preview.";
export const LAYOUT_INVALID = "Invalid TIFF metadata.";

const TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
  16: 8,
  17: 8,
  18: 8,
};
const BLOCK_TAGS = new Set([273, 279, 324, 325]);

interface Entry {
  readonly tag: number;
  readonly count: number;
  readonly bytes: number;
  readonly value: number;
  /** Where an out-of-line value starts; null when it fits in the entry. */
  readonly offset: number | null;
}

export interface TiffLayout {
  /** File offset of each directory, in order. */
  readonly offsets: readonly number[];
  readonly subfileTypes: readonly number[];
}

function refuse(): never {
  throw new Error(LAYOUT_UNSUPPORTED);
}

async function readBytes(tiff: GeoTIFF, offset: number, length: number) {
  const [data] = await tiff.source.fetch([{ offset, length }]);
  if (!data || data.byteLength < length) throw new Error(LAYOUT_INVALID);
  return new DataView(data);
}

async function readDirectory(tiff: GeoTIFF, offset: number) {
  const big = tiff.bigTiff;
  const little = tiff.littleEndian;
  const head = await readBytes(tiff, offset, big ? 8 : 2);
  const entries = big ? Number(head.getBigUint64(0, little)) : head.getUint16(0, little);
  if (entries < 1 || entries > MAX_ENTRIES) refuse();
  const entrySize = big ? 20 : 12;
  const start = offset + (big ? 8 : 2);
  const view = await readBytes(tiff, start, entries * entrySize + (big ? 8 : 4));
  const list: Entry[] = [];
  for (let index = 0; index < entries; index++) {
    const at = index * entrySize;
    const type = view.getUint16(at + 2, little);
    const size = TYPE_BYTES[type];
    if (!size) refuse();
    const count = big ? Number(view.getBigUint64(at + 4, little)) : view.getUint32(at + 4, little);
    const valueAt = at + (big ? 12 : 8);
    // Small SHORT and LONG values sit inline; only those are needed to size the block arrays.
    const value =
      type === 3
        ? view.getUint16(valueAt, little)
        : type === 4
          ? view.getUint32(valueAt, little)
          : type === 16
            ? Number(view.getBigUint64(valueAt, little))
            : 0;
    const bytes = count * size;
    const offset =
      bytes > (big ? 8 : 4)
        ? big
          ? Number(view.getBigUint64(valueAt, little))
          : view.getUint32(valueAt, little)
        : null;
    list.push({ tag: view.getUint16(at, little), count, bytes, value, offset });
  }
  const tail = entries * entrySize;
  const next = big ? Number(view.getBigUint64(tail, little)) : view.getUint32(tail, little);
  return { entries: list, next };
}

function checkDirectory(entries: readonly Entry[], fileSize: number | null) {
  const value = (tag: number) => entries.find((entry) => entry.tag === tag)?.value;
  const width = value(256) ?? 0;
  const height = value(257) ?? 0;
  if (!(width > 0 && height > 0)) refuse();
  const planes = value(284) === 2 ? (value(277) ?? 1) : 1;
  const tileWidth = value(322);
  const tileHeight = value(323);
  const tiled = tileWidth !== undefined || tileHeight !== undefined;
  if (tiled && !(tileWidth! > 0 && tileHeight! > 0)) refuse();
  const rows = Math.min(value(278) || height, height);
  const blocks = tiled
    ? Math.ceil(width / tileWidth!) * Math.ceil(height / tileHeight!) * planes
    : Math.ceil(height / rows) * planes;
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes)) refuse();
    if (entry.offset !== null) {
      total += entry.bytes;
      // A value that runs past the end of the file is truncated metadata.
      if (fileSize !== null && entry.offset + entry.bytes > fileSize)
        throw new Error(LAYOUT_INVALID);
    }
    if (
      BLOCK_TAGS.has(entry.tag)
        ? entry.count > Math.min(blocks, MAX_BLOCKS)
        : entry.bytes > MAX_TAG_BYTES
    )
      refuse();
  }
  return total;
}

const checked = new WeakMap<GeoTIFF, Promise<TiffLayout>>();

/**
 * Reads every directory's entries before geotiff sees any of them, because geotiff allocates
 * arrays straight from their counts. Values must lie inside the file, and all directories together
 * may declare at most 64 MiB of arrays.
 */
export function checkTiffLayout(tiff: GeoTIFF) {
  let result = checked.get(tiff);
  if (!result) {
    result = (async () => {
      const offsets: number[] = [];
      const subfileTypes: number[] = [];
      const seen = new Set<number>();
      let metadata = 0;
      let offset = tiff.firstIFDOffset;
      while (offset && !seen.has(offset) && seen.size < MAX_TIFF_DIRECTORIES) {
        seen.add(offset);
        const directory = await readDirectory(tiff, offset);
        metadata += checkDirectory(directory.entries, tiff.source.fileSize);
        if (metadata > MAX_METADATA_BYTES) refuse();
        offsets.push(offset);
        subfileTypes.push(directory.entries.find((entry) => entry.tag === 254)?.value ?? 0);
        offset = directory.next;
      }
      if (!offsets.length) refuse();
      return { offsets, subfileTypes };
    })();
    checked.set(tiff, result);
  }
  return result;
}
