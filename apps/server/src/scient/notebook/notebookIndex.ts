import { computeLanguageIdFromName } from "@scientfactory/compute";
import type { NotebookRevisionSource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

/** Outputs this small travel with the notebook; larger ones load when their cell is on screen. */
const INLINE_OUTPUT_BYTES = 64 * 1024;

class NotebookFormatError extends Schema.TaggedError<NotebookFormatError>()("NotebookFormatError", {
  message: Schema.String,
}) {}

interface Range {
  readonly start: number;
  readonly end: number;
}

function stringEnd(buffer: Buffer, start: number): number {
  let cursor = start + 1;
  for (;;) {
    // Base64 holds no quotes, so a figure of any size is one native search.
    const quote = buffer.indexOf(QUOTE, cursor);
    if (quote < 0) throw new NotebookFormatError({ message: "Unterminated string" });
    let backslashes = 0;
    while (buffer[quote - 1 - backslashes] === BACKSLASH) backslashes += 1;
    if (backslashes % 2 === 0) return quote + 1;
    cursor = quote + 1;
  }
}

function skipSpace(buffer: Buffer, start: number): number {
  let cursor = start;
  for (;;) {
    const byte = buffer[cursor];
    if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) return cursor;
    cursor += 1;
  }
}

function valueEnd(buffer: Buffer, start: number): number {
  const first = buffer[start];
  if (first === undefined) throw new NotebookFormatError({ message: "Unexpected end of file" });
  if (first === QUOTE) return stringEnd(buffer, start);
  if (first === COMMA || first === CLOSE_BRACE || first === CLOSE_BRACKET) {
    throw new NotebookFormatError({ message: "Expected a value" });
  }
  if (first !== OPEN_BRACE && first !== OPEN_BRACKET) {
    let cursor = start;
    for (;;) {
      const byte = buffer[cursor];
      if (
        byte === undefined ||
        byte === COMMA ||
        byte === CLOSE_BRACE ||
        byte === CLOSE_BRACKET ||
        byte === 0x20 ||
        byte === 0x0a ||
        byte === 0x0d ||
        byte === 0x09
      ) {
        return cursor;
      }
      cursor += 1;
    }
  }
  const closers: number[] = [];
  let cursor = start;
  for (;;) {
    const byte = buffer[cursor];
    if (byte === undefined) throw new NotebookFormatError({ message: "Unexpected end of file" });
    if (byte === QUOTE) {
      cursor = stringEnd(buffer, cursor);
      continue;
    }
    if (byte === OPEN_BRACE) closers.push(CLOSE_BRACE);
    else if (byte === OPEN_BRACKET) closers.push(CLOSE_BRACKET);
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      if (closers.pop() !== byte) throw new NotebookFormatError({ message: "Mismatched brackets" });
      if (closers.length === 0) return cursor + 1;
    }
    cursor += 1;
  }
}

/** The next item after a value: past a comma, or at the closer. */
function nextItem(buffer: Buffer, afterValue: number, closer: number): number {
  const cursor = skipSpace(buffer, afterValue);
  if (buffer[cursor] === closer) return cursor;
  if (buffer[cursor] !== COMMA) throw new NotebookFormatError({ message: "Expected a comma" });
  const next = skipSpace(buffer, cursor + 1);
  if (buffer[next] === closer)
    throw new NotebookFormatError({ message: "Unexpected trailing comma" });
  return next;
}

function objectMembers(buffer: Buffer, range: Range): ReadonlyArray<readonly [string, Range]> {
  if (buffer[range.start] !== OPEN_BRACE)
    throw new NotebookFormatError({ message: "Expected an object" });
  const members: Array<readonly [string, Range]> = [];
  let cursor = skipSpace(buffer, range.start + 1);
  while (cursor < range.end && buffer[cursor] !== CLOSE_BRACE) {
    const keyEnd = stringEnd(buffer, cursor);
    const key = JSON.parse(buffer.toString("utf8", cursor, keyEnd)) as string;
    const colon = skipSpace(buffer, keyEnd);
    if (buffer[colon] !== COLON) throw new NotebookFormatError({ message: "Expected a colon" });
    const start = skipSpace(buffer, colon + 1);
    const end = valueEnd(buffer, start);
    members.push([key, { start, end }]);
    cursor = nextItem(buffer, end, CLOSE_BRACE);
  }
  return members;
}

function arrayItems(buffer: Buffer, range: Range): ReadonlyArray<Range> {
  if (buffer[range.start] !== OPEN_BRACKET)
    throw new NotebookFormatError({ message: "Expected an array" });
  const items: Range[] = [];
  let cursor = skipSpace(buffer, range.start + 1);
  while (cursor < range.end && buffer[cursor] !== CLOSE_BRACKET) {
    const end = valueEnd(buffer, cursor);
    items.push({ start: cursor, end });
    cursor = nextItem(buffer, end, CLOSE_BRACKET);
  }
  return items;
}

const parseRange = (buffer: Buffer, range: Range): unknown =>
  JSON.parse(buffer.toString("utf8", range.start, range.end));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function notebookCellTags(fields: NotebookCellRecord["fields"]): ReadonlyArray<unknown> {
  const tags = isRecord(fields.metadata) ? fields.metadata.tags : undefined;
  return Array.isArray(tags) ? tags : [];
}

/** nbformat stores multiline text as a string or as a list of lines. */
export function notebookSourceCell({
  id,
  fields,
}: NotebookCellRecord): NotebookRevisionSource["cells"][number] {
  const tags = notebookCellTags(fields);
  const cellType =
    fields.cell_type === "markdown" || fields.cell_type === "raw" ? fields.cell_type : "code";
  return {
    id,
    cellType,
    source: notebookText(fields.source),
    ...(cellType === "code" && tags.includes("parameters") ? { parameterCell: true } : {}),
    ...(cellType === "code" && tags.includes("injected-parameters")
      ? { injectedParameters: true }
      : {}),
  };
}

export function notebookText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((line) => typeof line === "string").join("") : "";
}

export interface IndexedOutput {
  readonly outputType: string;
  readonly mediaTypes: ReadonlyArray<string>;
  /** Where the output sits in its cell's `outputs` bytes. */
  readonly range: Range;
}

export function indexOutputs(outputs: Buffer): ReadonlyArray<IndexedOutput> {
  return arrayItems(outputs, { start: skipSpace(outputs, 0), end: outputs.length }).map((range) => {
    let outputType = "";
    let mediaTypes: ReadonlyArray<string> = [];
    for (const [key, value] of objectMembers(outputs, range)) {
      if (key === "output_type") outputType = String(parseRange(outputs, value));
      else if (key === "data") mediaTypes = objectMembers(outputs, value).map(([name]) => name);
    }
    return { outputType, mediaTypes, range };
  });
}

export interface NotebookCellRecord {
  readonly id: string;
  /** Every cell field in saved order. `outputs` stays as bytes in `outputs`. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly outputs: Buffer | null;
  readonly outputIndex: ReadonlyArray<IndexedOutput>;
  /** The cell exactly as saved, until an edit means it must be written again. */
  readonly saved: Buffer | null;
  readonly rawFields?: ReadonlyMap<string, { readonly bytes: Buffer; readonly value: unknown }>;
}

export interface NotebookIndex {
  readonly head: Buffer;
  readonly tail: Buffer;
  readonly language: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly metadataRange?: Range & { readonly part: "head" | "tail" };
  readonly cells: ReadonlyArray<NotebookCellRecord>;
  readonly minor: number;
  readonly originalCells: ReadonlyArray<NotebookCellRecord>;
  readonly gaps: ReadonlyArray<Buffer>;
}

function notebookLanguage(metadata: unknown): string {
  if (!isRecord(metadata)) return "python";
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const language =
    (typeof languageInfo.name === "string" && languageInfo.name) ||
    (typeof kernelspec.language === "string" && kernelspec.language) ||
    "python";
  return computeLanguageIdFromName(language);
}

function indexCell(buffer: Buffer, range: Range, ids: CellIds): NotebookCellRecord {
  const fields = Object.create(null) as Record<string, unknown>;
  const rawFields = new Map<string, { bytes: Buffer; value: unknown }>();
  let outputs: Buffer | null = null;
  for (const [key, value] of objectMembers(buffer, range)) {
    if (key === "outputs") {
      outputs = buffer.subarray(value.start, value.end);
      fields.outputs = null;
    } else {
      fields[key] = parseRange(buffer, value);
      rawFields.set(key, { bytes: buffer.subarray(value.start, value.end), value: fields[key] });
    }
  }
  const saved = typeof fields.id === "string" && fields.id.length > 0 ? fields.id : null;
  const unique = saved !== null && !ids.seen.has(saved);
  const id = unique ? saved : unusedCellId(ids);
  ids.seen.add(id);
  return {
    id,
    fields,
    outputs,
    outputIndex: outputs === null ? [] : indexOutputs(outputs),
    saved: buffer.subarray(range.start, range.end),
    rawFields,
  };
}

interface CellIds {
  /** Every id saved in the file, including cells not reached yet. */
  readonly saved: ReadonlySet<string>;
  readonly seen: Set<string>;
}

function unusedCellId(ids: CellIds): string {
  let number = ids.seen.size + 1;
  while (ids.saved.has(`cell-${number}`) || ids.seen.has(`cell-${number}`)) number += 1;
  return `cell-${number}`;
}

function savedCellIds(buffer: Buffer, ranges: ReadonlyArray<Range>): Set<string> {
  const ids = new Set<string>();
  for (const range of ranges) {
    const id = objectMembers(buffer, range).find(([key]) => key === "id")?.[1];
    const value = id === undefined ? null : parseRange(buffer, id);
    if (typeof value === "string" && value.length > 0) ids.add(value);
  }
  return ids;
}

/** Reads a notebook's structure without decoding its stored figures. */
export function indexNotebook(buffer: Buffer): NotebookIndex {
  if (buffer.length === 0) {
    return indexNotebook(
      Buffer.from('{\n "cells": [],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n'),
    );
  }
  const root = skipSpace(buffer, 0);
  const members = objectMembers(buffer, { start: root, end: valueEnd(buffer, root) });
  const cells = members.find(([key]) => key === "cells")?.[1];
  if (cells === undefined) throw new NotebookFormatError({ message: "This file has no cells" });
  const metadata = members.find(([key]) => key === "metadata")?.[1];
  const parsedMetadata = metadata === undefined ? {} : parseRange(buffer, metadata);
  const metadataRange =
    metadata === undefined
      ? undefined
      : metadata.start < cells.start
        ? { ...metadata, part: "head" as const }
        : {
            start: metadata.start - cells.end + 1,
            end: metadata.end - cells.end + 1,
            part: "tail" as const,
          };
  const cellRanges = arrayItems(buffer, cells);
  const ids: CellIds = { saved: savedCellIds(buffer, cellRanges), seen: new Set() };
  const records = cellRanges.map((range) => indexCell(buffer, range, ids));
  const gaps = cellRanges.map((range, index) =>
    buffer.subarray(cellRanges[index - 1]?.end ?? cells.start + 1, range.start),
  );
  gaps.push(buffer.subarray(cellRanges.at(-1)?.end ?? cells.start + 1, cells.end - 1));
  const minorField = members.find(([key]) => key === "nbformat_minor")?.[1];
  const minor = minorField === undefined ? null : parseRange(buffer, minorField);
  return {
    head: buffer.subarray(0, cells.start + 1),
    tail: buffer.subarray(cells.end - 1),
    language: notebookLanguage(parsedMetadata),
    metadata: isRecord(parsedMetadata) ? parsedMetadata : {},
    ...(metadataRange === undefined ? {} : { metadataRange }),
    cells: records,
    minor: typeof minor === "number" ? minor : 0,
    originalCells: records,
    gaps,
  };
}

export function notebookWithMetadata(
  notebook: NotebookIndex,
  metadata: Readonly<Record<string, unknown>>,
  replacer: (key: string, value: unknown) => unknown,
): NotebookIndex {
  const encoded = Buffer.from(JSON.stringify(metadata, replacer, 1).replaceAll("\n", "\n "));
  const range = notebook.metadataRange;
  if (range === undefined) {
    const prefix = Buffer.from('],\n "metadata": ');
    return {
      ...notebook,
      metadata,
      metadataRange: { part: "tail", start: prefix.length, end: prefix.length + encoded.length },
      tail: Buffer.concat([
        prefix,
        encoded,
        Buffer.from(notebook.tail[skipSpace(notebook.tail, 1)] === 0x7d ? "" : ","),
        notebook.tail.subarray(1),
      ]),
    };
  }
  const buffer = notebook[range.part];
  return {
    ...notebook,
    metadata,
    metadataRange: { ...range, end: range.start + encoded.length },
    [range.part]: Buffer.concat([
      buffer.subarray(0, range.start),
      encoded,
      buffer.subarray(range.end),
    ]),
  };
}

function orderedFields(_key: string, value: unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, value[key]]),
      )
    : value;
}

export function notebookCellFieldBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, orderedFields, 1).replaceAll("\n", "\n   "));
}

function cellBytes(cell: NotebookCellRecord, minor: number): Buffer {
  if (cell.saved !== null) return cell.saved;
  const fields = { ...cell.fields };
  if (minor >= 5 || cell.rawFields?.has("id")) fields.id = cell.id;
  else delete fields.id;
  const parts: Buffer[] = [Buffer.from("{")];
  const keys = Object.keys(fields).sort();
  for (const [index, key] of keys.entries()) {
    const value = fields[key];
    parts.push(Buffer.from(`${index === 0 ? "" : ","}\n   ${JSON.stringify(key)}: `));
    const original = cell.rawFields?.get(key);
    parts.push(
      key === "outputs" && cell.outputs !== null
        ? cell.outputs
        : original !== undefined && original.value === value
          ? original.bytes
          : notebookCellFieldBytes(value),
    );
  }
  parts.push(Buffer.from("\n  }"));
  return Buffer.concat(parts);
}

/** Cells and whitespace nobody edited are copied exactly as they were saved. */
export function notebookBytes(notebook: NotebookIndex): Buffer {
  const parts: Buffer[] = [notebook.head];
  const sameOrder =
    notebook.cells.length === notebook.originalCells.length &&
    notebook.cells.every((cell, index) => cell.id === notebook.originalCells[index]?.id);
  if (sameOrder) {
    notebook.cells.forEach((cell, index) => {
      parts.push(notebook.gaps[index]!, cellBytes(cell, notebook.minor));
    });
    parts.push(notebook.gaps.at(-1)!);
  } else {
    const separator = Buffer.from(",\n  ");
    const open = Buffer.from("\n  ");
    const close = Buffer.from("\n ");
    notebook.cells.forEach((cell, index) => {
      parts.push(index === 0 ? open : separator, cellBytes(cell, notebook.minor));
    });
    if (notebook.cells.length > 0) parts.push(close);
  }
  parts.push(notebook.tail);
  return Buffer.concat(parts);
}

export { INLINE_OUTPUT_BYTES };
