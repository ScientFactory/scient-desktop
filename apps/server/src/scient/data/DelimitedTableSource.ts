// @effect-diagnostics nodeBuiltinImport:off -- seeks within a file far larger than memory.
import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";

import { dataTableCellText, type DataTableColumn } from "@scientfactory/compute";

import type { SortKeys, TableSource } from "./TableView.ts";
import { inferTextColumnType } from "./cellText.ts";

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const CHUNK_BYTES = 4 * 1024 * 1024;
const SAMPLE_ROWS = 1000;
/** Index, sort and search memory grow with rows; beyond this only the first rows are shown. */
const DELIMITED_MAX_ROWS = 5_000_000;

const utf8 = new TextDecoder("utf-8");

/** Splits one record, honoring quotes; stops after `limit` cells. */
function parseDelimitedRecord(record: string, delimiter: string, limit = Infinity) {
  let end = record.length;
  if (record.charCodeAt(end - 1) === LF) end--;
  if (record.charCodeAt(end - 1) === CR) end--;
  const text = record.slice(0, end);
  const cells: string[] = [];
  let index = 0;
  while (cells.length < limit) {
    let value = "";
    if (text.charCodeAt(index) === QUOTE) {
      index++;
      while (index < end) {
        const quote = text.indexOf('"', index);
        if (quote < 0) {
          value += text.slice(index);
          index = end;
        } else if (text.charCodeAt(quote + 1) === QUOTE) {
          value += text.slice(index, quote + 1);
          index = quote + 2;
        } else {
          value += text.slice(index, quote);
          index = quote + 1;
          break;
        }
      }
    }
    const next = text.indexOf(delimiter, index);
    value += text.slice(index, next < 0 ? end : next);
    cells.push(value);
    if (next < 0) break;
    index = next + delimiter.length;
  }
  return cells;
}

/** The delimiter a `.csv` header line uses: comma unless another clearly leads. */
function sniffDelimiter(header: string): string {
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", ";", "\t", "|"]) {
    let count = 0;
    let quoted = false;
    for (const char of header) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

interface RowIndex {
  /** File offset where each record starts, then where the last one ends. */
  readonly offsets: Float64Array;
  /** Records, the header included. */
  readonly records: number;
  readonly truncated: boolean;
}

/**
 * Finds every record start in one pass over the bytes. A quote opens a quoted field only at the
 * start of a field, so a stray inch mark in unquoted text cannot swallow the rest of the file.
 */
async function indexRows(
  handle: NodeFSP.FileHandle,
  size: number,
  delimiter: number,
  signal: AbortSignal,
): Promise<RowIndex> {
  const buffer = NodeBuffer.Buffer.allocUnsafe(CHUNK_BYTES);
  let offsets = new Float64Array(65_536);
  let rows = 0;
  const push = (offset: number) => {
    if (rows === offsets.length) {
      const grown = new Float64Array(offsets.length * 2);
      grown.set(offsets);
      offsets = grown;
    }
    offsets[rows++] = offset;
  };
  const head = NodeBuffer.Buffer.alloc(3);
  await handle.read(head, 0, 3, 0);
  let rowStart = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  // 0 field start, 1 unquoted, 2 quoted, 3 quote seen inside quotes.
  let state = 0;
  let previous = LF;
  let truncated = false;
  const endRow = (end: number) => {
    const length = end - rowStart;
    if (length > 1 || (length === 1 && previous !== CR)) push(rowStart);
    rowStart = end + 1;
    state = 0;
  };
  scan: for (let position = rowStart; position < size;) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let nextQuote = -1;
    let index = 0;
    while (index < bytesRead) {
      if (rows > DELIMITED_MAX_ROWS + 1) {
        truncated = true;
        rowStart = offsets[--rows]!;
        break scan;
      }
      if (state === 2) {
        const quote = chunk.indexOf(QUOTE, index);
        if (quote < 0) {
          previous = chunk[bytesRead - 1]!;
          index = bytesRead;
          break;
        }
        state = 3;
        previous = QUOTE;
        index = quote + 1;
        continue;
      }
      if (state === 3) {
        const byte = chunk[index]!;
        if (byte === QUOTE) state = 2;
        else if (byte === delimiter) state = 0;
        else if (byte === LF) endRow(position + index);
        else state = 1;
        previous = byte;
        index++;
        continue;
      }
      if (nextQuote < index) {
        nextQuote = chunk.indexOf(QUOTE, index);
        if (nextQuote < 0) nextQuote = bytesRead;
      }
      const lineFeed = chunk.indexOf(LF, index);
      const lineEnd = lineFeed < 0 ? bytesRead : lineFeed;
      if (nextQuote < lineEnd) {
        const before = nextQuote === 0 ? previous : chunk[nextQuote - 1]!;
        const atFieldStart =
          before === delimiter || position + nextQuote === rowStart || before === LF;
        state = atFieldStart ? 2 : 1;
        previous = QUOTE;
        index = nextQuote + 1;
      } else if (lineEnd < bytesRead) {
        previous = lineEnd === 0 ? previous : chunk[lineEnd - 1]!;
        endRow(position + lineEnd);
        previous = LF;
        index = lineEnd + 1;
      } else {
        state = 1;
        previous = chunk[bytesRead - 1]!;
        index = bytesRead;
      }
    }
    position += bytesRead;
  }
  if (!truncated && rowStart < size) push(rowStart);
  push(truncated ? rowStart : size);
  return { offsets, records: rows - 1, truncated };
}

interface Rows {
  readonly first: number;
  readonly texts: ReadonlyArray<string>;
}

/** Reads consecutive rows `[first, end)` of the file as text, one string per row. */
async function readRowTexts(
  handle: NodeFSP.FileHandle,
  index: RowIndex,
  first: number,
  end: number,
): Promise<Rows> {
  const start = index.offsets[first]!;
  const length = index.offsets[end]! - start;
  const bytes = NodeBuffer.Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(bytes, 0, length, start);
  const view = bytes.subarray(0, bytesRead);
  const texts: string[] = [];
  // ASCII text decodes once and splits by byte offsets; anything else decodes per row.
  if (NodeBuffer.isAscii(view)) {
    const text = view.toString("latin1");
    for (let row = first; row < end; row++)
      texts.push(text.slice(index.offsets[row]! - start, index.offsets[row + 1]! - start));
  } else {
    for (let row = first; row < end; row++)
      texts.push(
        utf8.decode(view.subarray(index.offsets[row]! - start, index.offsets[row + 1]! - start)),
      );
  }
  return { first, texts };
}

async function forEachRow(
  handle: NodeFSP.FileHandle,
  index: RowIndex,
  signal: AbortSignal,
  visit: (row: number, text: string) => void,
) {
  // Record 0 is the header.
  for (let first = 1; first < index.records;) {
    signal.throwIfAborted();
    let end = first + 1;
    while (end < index.records && index.offsets[end + 1]! - index.offsets[first]! <= CHUNK_BYTES)
      end++;
    const { texts } = await readRowTexts(handle, index, first, end);
    for (let offset = 0; offset < texts.length; offset++) visit(first + offset - 1, texts[offset]!);
    first = end;
  }
}

async function withFile<T>(path: string, use: (handle: NodeFSP.FileHandle) => Promise<T>) {
  const handle = await NodeFSP.open(path, "r");
  try {
    return await use(handle);
  } finally {
    await handle.close();
  }
}

export async function openDelimitedSource(
  path: string,
  size: number,
  delimiter: string | null,
  signal: AbortSignal,
): Promise<TableSource> {
  const { index, header, sample, separator } = await withFile(path, async (handle) => {
    const firstLine = NodeBuffer.Buffer.alloc(Math.min(size, 64 * 1024));
    await handle.read(firstLine, 0, firstLine.length, 0);
    const text = utf8.decode(firstLine);
    const lineEnd = text.indexOf("\n");
    const separator = delimiter ?? sniffDelimiter(lineEnd < 0 ? text : text.slice(0, lineEnd));
    const index = await indexRows(handle, size, separator.charCodeAt(0), signal);
    if (index.records === 0) return { index, header: [], sample: [], separator };
    const head = await readRowTexts(handle, index, 0, Math.min(index.records, SAMPLE_ROWS + 1));
    const [header = "", ...sample] = head.texts.map((row) => parseDelimitedRecord(row, separator));
    return { index, header, sample, separator };
  });
  const rowCount = Math.max(0, index.records - 1);
  const width = sample.reduce((max, cells) => Math.max(max, cells.length), header.length);
  const columns: DataTableColumn[] = Array.from({ length: width }, (_, column) => ({
    name: header[column] || `Column ${column + 1}`,
    ...inferTextColumnType(sample.map((cells) => cells[column])),
  }));
  const numeric = columns.map((column) => column.type === "integer" || column.type === "number");
  return {
    columns,
    rowCount,
    truncated: index.truncated,
    readRows: (rows, columnLimit, rowSignal) =>
      withFile(path, async (handle) => {
        const cells = Array.from<Array<string | null>>({ length: rows.length });
        const ordered = rows
          .map((row, position) => ({ row, position }))
          .sort((a, b) => a.row - b.row);
        for (let start = 0; start < ordered.length;) {
          rowSignal.throwIfAborted();
          let end = start + 1;
          while (end < ordered.length && ordered[end]!.row === ordered[end - 1]!.row + 1) end++;
          const { texts } = await readRowTexts(
            handle,
            index,
            ordered[start]!.row + 1,
            ordered[end - 1]!.row + 2,
          );
          for (let offset = 0; offset < texts.length; offset++) {
            const values = parseDelimitedRecord(texts[offset]!, separator, columnLimit);
            cells[ordered[start + offset]!.position] = Array.from(
              { length: Math.min(columnLimit, columns.length) },
              (_, column) => {
                const value = values[column];
                return value === undefined ? null : dataTableCellText(value);
              },
            );
          }
          start = end;
        }
        return cells;
      }),
    sortKeys: (column, keySignal) =>
      withFile(path, async (handle): Promise<SortKeys> => {
        if (numeric[column]) {
          const keys = new Float64Array(rowCount);
          await forEachRow(handle, index, keySignal, (row, text) => {
            const value = parseDelimitedRecord(text, separator, column + 1)[column]?.trim();
            keys[row] = value ? Number(value) : Number.NaN;
          });
          return keys;
        }
        const keys = Array.from<string | null>({ length: rowCount });
        await forEachRow(handle, index, keySignal, (row, text) => {
          keys[row] = parseDelimitedRecord(text, separator, column + 1)[column] || null;
        });
        return keys;
      }),
    search: (needle, searchSignal) =>
      withFile(path, async (handle) => {
        const matches: number[] = [];
        await forEachRow(handle, index, searchSignal, (row, text) => {
          if (!text.toLowerCase().includes(needle) && !needle.includes('"')) return;
          if (
            parseDelimitedRecord(text, separator).some((cell) =>
              cell.toLowerCase().includes(needle),
            )
          )
            matches.push(row);
        });
        return Uint32Array.from(matches);
      }),
  };
}
