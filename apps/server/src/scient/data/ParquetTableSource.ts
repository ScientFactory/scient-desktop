import {
  dataTableCellText,
  type DataTableColumn,
  type DataTableColumnType,
} from "@scientfactory/compute";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type SchemaElement,
  type SchemaTree,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";

import { formatDate, formatValue } from "./cellText.ts";
import type { TableSource } from "./TableView.ts";

/** Decoded column chunks kept per open file; reading a row decodes its whole row group. */
const CHUNK_CACHE_BYTES = 192 * 1024 * 1024;

function columnKind(node: SchemaTree): Pick<DataTableColumn, "type" | "label"> {
  const element: SchemaElement = node.element;
  if (node.children.length > 0) {
    const logical = element.logical_type?.type ?? element.converted_type;
    return { type: "other", label: logical === "LIST" ? "list" : logical === "MAP" ? "map" : "struct" };
  }
  const logical = element.logical_type;
  const typed = (type: DataTableColumnType, label: string) => ({ type, label });
  switch (logical?.type) {
    case "STRING":
    case "ENUM":
    case "JSON":
    case "UUID":
      return typed("text", "string");
    case "DATE":
      return typed("date", "date");
    case "TIMESTAMP":
      return typed("datetime", "timestamp");
    case "DECIMAL":
      return typed("number", "decimal");
    case "INTEGER":
      return typed("integer", `${logical.isSigned ? "int" : "uint"}${logical.bitWidth}`);
    case "FLOAT16":
      return typed("number", "float16");
    case undefined:
      break;
    default:
      return typed("other", logical.type.toLowerCase());
  }
  switch (element.converted_type) {
    case "UTF8":
    case "ENUM":
    case "JSON":
      return typed("text", "string");
    case "DATE":
      return typed("date", "date");
    case "TIMESTAMP_MILLIS":
    case "TIMESTAMP_MICROS":
      return typed("datetime", "timestamp");
    case "DECIMAL":
      return typed("number", "decimal");
    default:
      break;
  }
  switch (element.type) {
    case "BOOLEAN":
      return typed("boolean", "bool");
    case "INT32":
      return typed("integer", "int32");
    case "INT64":
      return typed("integer", "int64");
    case "INT96":
      return typed("datetime", "timestamp");
    case "FLOAT":
      return typed("number", "float");
    case "DOUBLE":
      return typed("number", "double");
    case "BYTE_ARRAY":
      return typed("text", "string");
    default:
      return typed("other", "binary");
  }
}

type Chunk = ArrayLike<unknown>;

export async function openParquetSource(path: string): Promise<TableSource> {
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  const nodes = parquetSchema(metadata).children;
  const columns: DataTableColumn[] = nodes.map((node) => ({
    name: node.element.name,
    ...columnKind(node),
  }));
  // Dates are held as epoch milliseconds: a Date object costs several times more.
  const temporal = columns.map((column) => column.type === "date" || column.type === "datetime");
  const display = (column: number, value: unknown) => {
    if (!temporal[column]) return formatValue(value);
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    return formatDate(new Date(value), columns[column]!.type === "datetime");
  };
  const groupStarts = [0];
  for (const group of metadata.row_groups) groupStarts.push(groupStarts.at(-1)! + Number(group.num_rows));
  const rowCount = groupStarts.at(-1)!;
  const groupOf = (row: number) => {
    let low = 0;
    let high = groupStarts.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (groupStarts[middle]! <= row) low = middle;
      else high = middle;
    }
    return low;
  };

  const cache = new Map<string, { readonly chunk: Promise<Chunk>; bytes: number }>();
  let cachedBytes = 0;
  const readChunk = (group: number, column: number): Promise<Chunk> => {
    const key = `${group}:${column}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.chunk;
    }
    const start = groupStarts[group]!;
    const values = new Array<unknown>(groupStarts[group + 1]! - start);
    const entry = {
      bytes: 0,
      chunk: parquetRead({
        file,
        metadata,
        compressors,
        columns: [columns[column]!.name],
        rowStart: start,
        rowEnd: groupStarts[group + 1]!,
        onChunk: ({ columnData, rowStart }) => {
          for (let index = 0; index < columnData.length; index++)
            values[rowStart - start + index] = columnData[index];
        },
      }).then(() => compactChunk(values, temporal[column]!)),
    };
    cache.set(key, entry);
    entry.chunk.then(
      (chunk) => {
        entry.bytes = estimateBytes(chunk);
        cachedBytes += entry.bytes;
        for (const [oldKey, old] of cache) {
          if (cachedBytes <= CHUNK_CACHE_BYTES || old === entry) break;
          cache.delete(oldKey);
          cachedBytes -= old.bytes;
        }
      },
      () => cache.delete(key),
    );
    return entry.chunk;
  };

  const forEachGroup = async (
    signal: AbortSignal,
    visit: (group: number, start: number) => Promise<void>,
  ) => {
    for (let group = 0; group < metadata.row_groups.length; group++) {
      signal.throwIfAborted();
      await visit(group, groupStarts[group]!);
    }
  };

  return {
    columns,
    rowCount,
    truncated: false,
    readRows: async (rows, columnLimit, signal) => {
      const width = Math.min(columnLimit, columns.length);
      const cells = rows.map(() => Array.from<string | null>({ length: width }));
      const byGroup = new Map<number, number[]>();
      rows.forEach((row, position) => {
        const group = groupOf(row);
        const positions = byGroup.get(group);
        if (positions) positions.push(position);
        else byGroup.set(group, [position]);
      });
      for (const [group, positions] of byGroup) {
        for (let column = 0; column < width; column++) {
          signal.throwIfAborted();
          const chunk = await readChunk(group, column);
          for (const position of positions) {
            const text = display(column, chunk[rows[position]! - groupStarts[group]!]);
            cells[position]![column] = text === null ? null : dataTableCellText(text);
          }
        }
      }
      return cells;
    },
    sortKeys: async (column, signal) => {
      const type = columns[column]!.type;
      const numeric = type === "integer" || type === "number" || temporal[column];
      const numbers = new Float64Array(rowCount);
      const texts = Array.from<string | null>({ length: numeric ? 0 : rowCount });
      await forEachGroup(signal, async (group, start) => {
        const chunk = await readChunk(group, column);
        for (let index = 0; index < chunk.length; index++) {
          const value = chunk[index];
          if (numeric) numbers[start + index] = value == null ? Number.NaN : Number(value);
          else texts[start + index] = formatValue(value);
        }
      });
      return numeric ? numbers : texts;
    },
    search: async (needle, signal) => {
      const matched = new Uint8Array(rowCount);
      await forEachGroup(signal, async (group, start) => {
        for (let column = 0; column < columns.length; column++) {
          signal.throwIfAborted();
          const chunk = await readChunk(group, column);
          for (let index = 0; index < chunk.length; index++) {
            if (matched[start + index]) continue;
            const text = display(column, chunk[index]);
            if (text?.toLowerCase().includes(needle)) matched[start + index] = 1;
          }
        }
      });
      const rows: number[] = [];
      for (let row = 0; row < rowCount; row++) if (matched[row]) rows.push(row);
      return Uint32Array.from(rows);
    },
  };
}

/** Numbers and dates (as epoch milliseconds) pack into a typed array; NaN is missing. */
function compactChunk(values: Array<unknown>, temporal: boolean): Chunk {
  if (temporal)
    return Float64Array.from(values, (value) => (value instanceof Date ? value.getTime() : Number.NaN));
  if (!values.every((value) => value == null || typeof value === "number")) return values;
  return Float64Array.from(values, (value) => (typeof value === "number" ? value : Number.NaN));
}

/** A rough heap size from a sample of the values. */
function estimateBytes(chunk: Chunk): number {
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  let sampled = 0;
  const step = Math.max(1, Math.floor(chunk.length / 256));
  for (let index = 0; index < chunk.length; index += step) {
    const value = chunk[index];
    sampled +=
      typeof value === "string"
        ? 24 + value.length * 2
        : typeof value === "object" && value !== null
          ? 64
          : typeof value === "bigint"
            ? 40
            : 8;
  }
  return (sampled / Math.ceil(chunk.length / step)) * chunk.length;
}
