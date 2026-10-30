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

class NotebookFormatError extends Error {}

interface Range {
  readonly start: number;
  readonly end: number;
}

function stringEnd(buffer: Buffer, start: number): number {
  let cursor = start + 1;
  for (;;) {
    // Base64 holds no quotes, so a figure of any size is one native search.
    const quote = buffer.indexOf(QUOTE, cursor);
    if (quote < 0) throw new NotebookFormatError("Unterminated string");
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
  if (first === undefined) throw new NotebookFormatError("Unexpected end of file");
  if (first === QUOTE) return stringEnd(buffer, start);
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
  let depth = 0;
  let cursor = start;
  for (;;) {
    const byte = buffer[cursor];
    if (byte === undefined) throw new NotebookFormatError("Unexpected end of file");
    if (byte === QUOTE) {
      cursor = stringEnd(buffer, cursor);
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
}

function objectMembers(buffer: Buffer, range: Range): ReadonlyArray<readonly [string, Range]> {
  if (buffer[range.start] !== OPEN_BRACE) throw new NotebookFormatError("Expected an object");
  const members: Array<readonly [string, Range]> = [];
  let cursor = skipSpace(buffer, range.start + 1);
  while (cursor < range.end && buffer[cursor] !== CLOSE_BRACE) {
    const keyEnd = stringEnd(buffer, cursor);
    const key = JSON.parse(buffer.toString("utf8", cursor, keyEnd)) as string;
    const colon = skipSpace(buffer, keyEnd);
    if (buffer[colon] !== COLON) throw new NotebookFormatError("Expected a colon");
    const start = skipSpace(buffer, colon + 1);
    const end = valueEnd(buffer, start);
    members.push([key, { start, end }]);
    cursor = skipSpace(buffer, end);
    if (buffer[cursor] === COMMA) cursor = skipSpace(buffer, cursor + 1);
  }
  return members;
}

function arrayItems(buffer: Buffer, range: Range): ReadonlyArray<Range> {
  if (buffer[range.start] !== OPEN_BRACKET) throw new NotebookFormatError("Expected an array");
  const items: Range[] = [];
  let cursor = skipSpace(buffer, range.start + 1);
  while (cursor < range.end && buffer[cursor] !== CLOSE_BRACKET) {
    const end = valueEnd(buffer, cursor);
    items.push({ start: cursor, end });
    cursor = skipSpace(buffer, end);
    if (buffer[cursor] === COMMA) cursor = skipSpace(buffer, cursor + 1);
  }
  return items;
}

const parseRange = (buffer: Buffer, range: Range): unknown =>
  JSON.parse(buffer.toString("utf8", range.start, range.end));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** nbformat stores multiline text as a string or as a list of lines. */
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
}

export interface NotebookIndex {
  readonly head: Buffer;
  readonly tail: Buffer;
  readonly language: string;
  readonly cells: ReadonlyArray<NotebookCellRecord>;
}

function notebookLanguage(metadata: unknown): string {
  if (!isRecord(metadata)) return "python";
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const language =
    (typeof languageInfo.name === "string" && languageInfo.name) ||
    (typeof kernelspec.language === "string" && kernelspec.language) ||
    "python";
  return language.toLowerCase();
}

function indexCell(buffer: Buffer, range: Range, position: number): NotebookCellRecord {
  const fields: Record<string, unknown> = {};
  let outputs: Buffer | null = null;
  for (const [key, value] of objectMembers(buffer, range)) {
    if (key === "outputs") {
      outputs = buffer.subarray(value.start, value.end);
      fields.outputs = null;
    } else {
      fields[key] = parseRange(buffer, value);
    }
  }
  const id = typeof fields.id === "string" && fields.id.length > 0 ? fields.id : null;
  return {
    id: id ?? `cell-${position + 1}`,
    fields,
    outputs,
    outputIndex: outputs === null ? [] : indexOutputs(outputs),
    // A cell without an id must be written once to gain one.
    saved: id === null ? null : buffer.subarray(range.start, range.end),
  };
}

/** Reads a notebook's structure without decoding its stored figures. */
export function indexNotebook(buffer: Buffer): NotebookIndex {
  if (buffer.length === 0) {
    return {
      head: Buffer.from('{\n "cells": ['),
      tail: Buffer.from('],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n'),
      language: "python",
      cells: [],
    };
  }
  const root = skipSpace(buffer, 0);
  const members = objectMembers(buffer, { start: root, end: valueEnd(buffer, root) });
  const cells = members.find(([key]) => key === "cells")?.[1];
  if (cells === undefined) throw new NotebookFormatError("This file has no cells");
  const metadata = members.find(([key]) => key === "metadata")?.[1];
  return {
    head: buffer.subarray(0, cells.start + 1),
    tail: buffer.subarray(cells.end - 1),
    language: notebookLanguage(metadata === undefined ? {} : parseRange(buffer, metadata)),
    cells: arrayItems(buffer, cells).map((range, position) => indexCell(buffer, range, position)),
  };
}

const OUTPUTS_MARKER = "\u0000scient-outputs";
const OUTPUTS_MARKER_JSON = JSON.stringify(OUTPUTS_MARKER);

function cellBytes(cell: NotebookCellRecord): Buffer {
  if (cell.saved !== null) return cell.saved;
  const fields = cell.outputs === null ? cell.fields : { ...cell.fields, outputs: OUTPUTS_MARKER };
  const json = JSON.stringify({ ...fields, id: cell.id }, null, 1).replaceAll("\n", "\n  ");
  if (cell.outputs === null) return Buffer.from(json);
  const at = json.indexOf(OUTPUTS_MARKER_JSON);
  return Buffer.concat([
    Buffer.from(json.slice(0, at)),
    cell.outputs,
    Buffer.from(json.slice(at + OUTPUTS_MARKER_JSON.length)),
  ]);
}

/** The notebook as bytes. Cells nobody edited are copied exactly as they were saved. */
export function notebookBytes(notebook: NotebookIndex): Buffer {
  const parts: Buffer[] = [notebook.head];
  const separator = Buffer.from(",\n  ");
  const open = Buffer.from("\n  ");
  const close = Buffer.from("\n ");
  notebook.cells.forEach((cell, index) => {
    parts.push(index === 0 ? open : separator, cellBytes(cell));
  });
  if (notebook.cells.length > 0) parts.push(close);
  parts.push(minorVersion(notebook.tail));
  return Buffer.concat(parts);
}

/** Cell ids need nbformat 4.5. */
function minorVersion(tail: Buffer): Buffer {
  const text = tail.toString("utf8");
  const updated = text.replace(/("nbformat_minor"\s*:\s*)([0-4])\b/, "$15");
  return updated === text ? tail : Buffer.from(updated);
}

export { INLINE_OUTPUT_BYTES };
