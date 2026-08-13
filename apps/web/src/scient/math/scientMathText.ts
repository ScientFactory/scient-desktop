import { useMemo } from "react";

/**
 * Rewrites the TeX delimiters models emit — `\(...\)` and `\[...\]` — into the
 * `$$` forms remark-math parses. Every replacement swaps a two-character
 * delimiter for the two-character `$$`, so the rewritten string is exactly the
 * same length as the source and no character offset ever moves. Offset-based
 * behavior (task-list toggling, list-item positions) therefore stays correct on
 * every surface, with no per-surface gating.
 *
 * Mid-sentence pairs render as inline math; a pair alone in its paragraph is
 * promoted to display math by `remarkScientMathRefinements`.
 */

interface ProtectedRange {
  readonly start: number;
  readonly end: number;
}

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE_LINE_PATTERN = /^(?: {4,}|\t)/;
const INLINE_CODE_SPAN_PATTERN = /(`+)[^`][\s\S]*?\1(?!`)|``(?!`)/g;
const RAW_CODE_REGION_PATTERN = /<(code|pre)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TEX_DELIMITER_PAIR_PATTERN =
  /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g;

/** Fenced blocks, line by line: ``` or ~~~ opens, an equal-or-longer run of the same marker closes, an unclosed fence protects to the end. */
function collectFencedRanges(text: string, ranges: ProtectedRange[]): void {
  let lineStart = 0;
  let fenceStart = -1;
  let fenceMarker = "";
  let fenceLength = 0;

  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (fenceStart === -1) {
      const opened = FENCE_OPEN_PATTERN.exec(line);
      if (opened?.[1]) {
        fenceStart = lineStart;
        fenceMarker = opened[1][0] ?? "`";
        fenceLength = opened[1].length;
      }
    } else {
      const closed = FENCE_OPEN_PATTERN.exec(line);
      if (
        closed?.[1] &&
        closed[1][0] === fenceMarker &&
        closed[1].length >= fenceLength &&
        line.trim() === closed[1].trim()
      ) {
        ranges.push({ start: fenceStart, end: lineEnd === -1 ? text.length : lineEnd });
        fenceStart = -1;
      }
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  if (fenceStart !== -1) {
    ranges.push({ start: fenceStart, end: text.length });
  }
}

/** Indented code candidates: any line at four-plus spaces or a tab. Over-protects deeply indented list prose, which safely stays literal. */
function collectIndentedLineRanges(text: string, ranges: ProtectedRange[]): void {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    if (INDENTED_CODE_LINE_PATTERN.test(text.slice(lineStart, end))) {
      ranges.push({ start: lineStart, end });
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
}

function collectPatternRanges(text: string, pattern: RegExp, ranges: ProtectedRange[]): void {
  for (const match of text.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
}

function overlapsProtected(ranges: ProtectedRange[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

export function normalizeScientMathDelimiters(text: string): string {
  if (!text.includes("\\[") && !text.includes("\\(")) {
    return text;
  }

  const protectedRanges: ProtectedRange[] = [];
  collectFencedRanges(text, protectedRanges);
  collectIndentedLineRanges(text, protectedRanges);
  collectPatternRanges(text, INLINE_CODE_SPAN_PATTERN, protectedRanges);
  collectPatternRanges(text, RAW_CODE_REGION_PATTERN, protectedRanges);

  let characters: string[] | null = null;
  for (const match of text.matchAll(TEX_DELIMITER_PAIR_PATTERN)) {
    const content = match[1] ?? match[2] ?? "";
    if (content.trim() === "") continue;
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsProtected(protectedRanges, start, end)) continue;

    // split("") keeps UTF-16 code units, so indices stay aligned with the
    // regex offsets even when the text contains astral characters.
    characters ??= text.split("");
    characters[start] = "$";
    characters[start + 1] = "$";
    characters[end - 2] = "$";
    characters[end - 1] = "$";
  }
  return characters === null ? text : characters.join("");
}

/** Memoized per message text, since streaming re-renders the same string repeatedly. */
export function useScientMathMarkdownText(text: string): string {
  return useMemo(() => normalizeScientMathDelimiters(text), [text]);
}
