/**
 * Neutral size bounds for text and lists that leave Scient: keep the head and
 * the tail, cut the middle, and say how much was cut. Used by the conversation
 * export projection; nothing here knows about providers or activity kinds.
 */
import type { ConversationBoundedText } from "@t3tools/contracts";

export interface TextBounds {
  /** Lines kept from the start and from the end when a text has too many lines. */
  readonly headLines: number;
  readonly tailLines: number;
  /** Characters kept from the start and from the end when a text is too long. */
  readonly headChars: number;
  readonly tailChars: number;
}

export const OMISSION_LINE_PATTERN = /^\[… \d+ lines? omitted …\]$/u;

function omissionLine(omittedLines: number): string {
  return `[… ${omittedLines} ${omittedLines === 1 ? "line" : "lines"} omitted …]`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * Whether `lines` are already this function's output for `bounds`: a head
 * and a tail within the character bounds, joined by one omission line. A cut
 * by characters splits a line in two and the omission line adds one more, so
 * the head and tail together may hold two lines beyond the line bounds.
 */
function isBoundedOutput(lines: ReadonlyArray<string>, bounds: TextBounds): boolean {
  const maxLines = bounds.headLines + bounds.tailLines + 2;
  if (lines.length > maxLines + 1) return false;
  return lines.some((line, index) => {
    if (!OMISSION_LINE_PATTERN.test(line)) return false;
    const head = lines.slice(0, index).join("\n");
    const tail = lines.slice(index + 1).join("\n");
    return head.length <= bounds.headChars && tail.length <= bounds.tailChars;
  });
}

/**
 * Bounds `text` by lines, then by characters. The kept head and tail are
 * joined by one "[… N lines omitted …]" line; `omittedLines` counts the whole
 * or partial lines removed and `omittedChars` the characters removed. Text
 * this function already bounded is returned as it is, with nothing further
 * omitted, so bounding is idempotent: an exported and re-imported text keeps
 * its own omission line and the counts recorded with it.
 */
export function boundText(text: string, bounds: TextBounds): ConversationBoundedText {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const withinBounds =
    lines.length <= bounds.headLines + bounds.tailLines + 1 &&
    normalized.length <= bounds.headChars + bounds.tailChars;
  if (withinBounds || isBoundedOutput(lines, bounds)) {
    return { text: normalized, omittedLines: 0, omittedChars: 0 };
  }
  let head = normalized;
  let tail = "";
  let omittedLines = 0;
  let omittedChars = 0;

  if (lines.length > bounds.headLines + bounds.tailLines + 1) {
    const middle = lines.slice(bounds.headLines, lines.length - bounds.tailLines);
    head = lines.slice(0, bounds.headLines).join("\n");
    tail = lines.slice(lines.length - bounds.tailLines).join("\n");
    omittedLines = middle.length;
    omittedChars = middle.join("\n").length;
  }

  if (omittedLines === 0) {
    if (normalized.length > bounds.headChars + bounds.tailChars) {
      const removed = normalized.slice(bounds.headChars, normalized.length - bounds.tailChars);
      head = normalized.slice(0, bounds.headChars);
      tail = normalized.slice(normalized.length - bounds.tailChars);
      omittedChars = removed.length;
      omittedLines = countLines(removed);
    }
  } else {
    // Lines that survived the line bound can still be very long.
    if (head.length > bounds.headChars) {
      const removed = head.slice(bounds.headChars);
      omittedChars += removed.length;
      omittedLines += countLines(removed);
      head = head.slice(0, bounds.headChars);
    }
    if (tail.length > bounds.tailChars) {
      const removed = tail.slice(0, tail.length - bounds.tailChars);
      omittedChars += removed.length;
      omittedLines += countLines(removed);
      tail = tail.slice(tail.length - bounds.tailChars);
    }
  }

  if (omittedChars === 0 && omittedLines === 0) {
    return { text: normalized, omittedLines: 0, omittedChars: 0 };
  }
  return {
    text: [head, omissionLine(omittedLines), tail].join("\n"),
    omittedLines,
    omittedChars,
  };
}

const encoder = new TextEncoder();

/**
 * The longest prefix of whole code points that fits in `maxBytes` UTF-8 bytes
 * and, when given, `maxCodePoints` code points. Never splits a surrogate pair.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
  maxCodePoints = Number.POSITIVE_INFINITY,
): string {
  let result = "";
  let bytes = 0;
  let count = 0;
  for (const codePoint of text) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > maxBytes || count + 1 > maxCodePoints) break;
    result += codePoint;
    bytes += size;
    count += 1;
  }
  return result;
}

const WARNING_VALUE_MAX_CODE_POINTS = 200;

/**
 * A value quoted inside a warning (a name, an alt text), on one line and short
 * enough that the warning always fits `DocumentWarning.message`.
 */
export function warningValue(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  const cut = truncateUtf8(line, Number.POSITIVE_INFINITY, WARNING_VALUE_MAX_CODE_POINTS);
  return cut === line ? line : `${cut.trimEnd()}…`;
}

/** Keeps the first `max` items and reports how many were left out. */
export function boundItems<A>(
  items: ReadonlyArray<A>,
  max: number,
): { readonly items: ReadonlyArray<A>; readonly omitted: number } {
  return items.length <= max
    ? { items, omitted: 0 }
    : { items: items.slice(0, max), omitted: items.length - max };
}
