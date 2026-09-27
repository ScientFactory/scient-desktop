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
 * Bounds `text` by lines, then by characters. The kept head and tail are
 * joined by one "[… N lines omitted …]" line; `omittedLines` counts the whole
 * or partial lines removed and `omittedChars` the characters removed.
 */
export function boundText(text: string, bounds: TextBounds): ConversationBoundedText {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
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

/** Keeps the first `max` items and reports how many were left out. */
export function boundItems<A>(
  items: ReadonlyArray<A>,
  max: number,
): { readonly items: ReadonlyArray<A>; readonly omitted: number } {
  return items.length <= max
    ? { items, omitted: 0 }
    : { items: items.slice(0, max), omitted: items.length - max };
}
