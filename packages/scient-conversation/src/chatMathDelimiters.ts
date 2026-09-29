/**
 * Chat's backslash-math delimiters, shared by chat rendering
 * (`apps/web/src/scient/math/scientMathText.ts`) and the conversation export,
 * so the export recognizes exactly the math chat renders. Pure and
 * parser-free.
 */

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

export type ScientBackslashMathDelimiter = "\\(" | "\\[";

export interface ScientBackslashMathSpan {
  readonly content: string;
  readonly delimiter: ScientBackslashMathDelimiter;
  readonly end: number;
  readonly start: number;
}

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE_LINE_PATTERN = /^(?: {4,}|\t)/;
const INLINE_CODE_SPAN_PATTERN = /(`+)[^`][\s\S]*?\1(?!`)|``(?!`)/g;
const RAW_CODE_REGION_PATTERN = /<(code|pre)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi;
// Attribute text inside a raw HTML tag is not markdown prose, so a delimiter
// lookalike in a title or href must survive verbatim. Text BETWEEN tags stays
// eligible — CommonMark treats inline-HTML content as ordinary prose.
const RAW_HTML_TAG_PATTERN = /<\/?[a-zA-Z][^<>\n]*>/g;
const RAW_HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;

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

function firstAfter(positions: ReadonlyArray<number>, start: number): number | undefined {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle]! <= start) low = middle + 1;
    else high = middle;
  }
  return positions[low];
}

/**
 * Finds authored TeX delimiter pairs in Markdown prose without interpreting
 * lookalikes inside code, raw HTML syntax, or escaped source. Offsets always
 * address the original UTF-16 string, so renderers and editors can share the
 * same source-preserving boundary.
 */
export function findScientBackslashMathSpans(text: string): ReadonlyArray<ScientBackslashMathSpan> {
  if (!text.includes("\\[") && !text.includes("\\(")) {
    return [];
  }

  const protectedRanges: ProtectedRange[] = [];
  collectFencedRanges(text, protectedRanges);
  collectIndentedLineRanges(text, protectedRanges);
  collectPatternRanges(text, INLINE_CODE_SPAN_PATTERN, protectedRanges);
  collectPatternRanges(text, RAW_CODE_REGION_PATTERN, protectedRanges);
  collectPatternRanges(text, RAW_HTML_TAG_PATTERN, protectedRanges);
  collectPatternRanges(text, RAW_HTML_COMMENT_PATTERN, protectedRanges);
  protectedRanges.sort((left, right) => left.start - right.start);

  // Index closers once. A lazy regex retries the entire remaining suffix for
  // every unmatched opener, which becomes quadratic on long agent output.
  const parenClosers: number[] = [];
  const bracketClosers: number[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== "\\" || text[index - 1] === "\\") continue;
    if (text[index + 1] === ")") parenClosers.push(index);
    else if (text[index + 1] === "]") bracketClosers.push(index);
  }

  const spans: ScientBackslashMathSpan[] = [];
  let protectedIndex = 0;
  for (let start = 0; start < text.length - 1; start += 1) {
    if (text[start] !== "\\" || text[start - 1] === "\\") continue;
    const opening = text[start + 1];
    if (opening !== "(" && opening !== "[") continue;
    const closer = firstAfter(opening === "(" ? parenClosers : bracketClosers, start + 1);
    if (closer === undefined) continue;
    const end = closer + 2;
    const content = text.slice(start + 2, closer);
    // A successful regex match consumes this whole range, even if empty or
    // protected, so later openers inside it cannot start another pair.
    const matchedStart = start;
    start = end - 1;
    if (content.trim() === "") continue;
    while (
      protectedRanges[protectedIndex]?.end !== undefined &&
      protectedRanges[protectedIndex]!.end <= matchedStart
    ) {
      protectedIndex += 1;
    }
    if (protectedRanges[protectedIndex] && protectedRanges[protectedIndex]!.start < end) continue;

    spans.push({
      content,
      delimiter: opening === "(" ? "\\(" : "\\[",
      end,
      start: matchedStart,
    });
  }
  return spans;
}

export function normalizeScientMathDelimiters(text: string): string {
  const spans = findScientBackslashMathSpans(text);
  if (spans.length === 0) return text;

  // split("") keeps UTF-16 code units, so indices stay aligned with the
  // source offsets even when the text contains astral characters.
  const characters = text.split("");
  for (const span of spans) {
    characters[span.start] = "$";
    characters[span.start + 1] = "$";
    characters[span.end - 2] = "$";
    characters[span.end - 1] = "$";
  }
  return characters.join("");
}
