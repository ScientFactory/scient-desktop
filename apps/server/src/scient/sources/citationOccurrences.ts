import { markdownProseTextSpans } from "@scientfactory/scient-markdown";
import {
  latexCitationItems,
  pandocCitationItems,
  type CitationItem,
} from "@scientfactory/scient-sources";

import { latexCiteOffsets, maskLatexComments } from "./citationKeyRename.ts";

/** One work one citation names; `start`/`end` cover the whole citation, `line`/`column` its start. */
interface CitationOccurrence extends CitationItem {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  /** `\nocite`: in the bibliography without a citation in the text. */
  readonly listedOnly: boolean;
}

interface FoundCitation {
  readonly item: CitationItem;
  readonly start: number;
  readonly end: number;
  readonly listedOnly: boolean;
}

function lineStarts(text: string): ReadonlyArray<number> {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

function locate(starts: ReadonlyArray<number>, offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low]! + 1 };
}

/** The text with everything but prose blanked; offsets and line breaks stay where they were. */
function proseOnly(text: string): string {
  const keep = new Uint8Array(text.length);
  for (const span of markdownProseTextSpans(text)) keep.fill(1, span.start, span.end);
  let masked = "";
  let run = 0;
  for (let at = 0; at <= text.length; at++) {
    if (at < text.length && keep[at] === 1) continue;
    masked += text.slice(run, at);
    if (at < text.length) masked += text[at] === "\n" || text[at] === "\r" ? text[at] : " ";
    run = at + 1;
  }
  return masked;
}

// The key rules of `citationKeyRename.ts`: a key follows the start, space, `[`, `;`, `(` or `-`
// (an e-mail address does not) and ends on a letter, digit or `_`.
const KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#-]*[\p{L}\p{N}_])?`;
const IN_TEXT = new RegExp(String.raw`(?<=^|[\s\[;(-])@(?:\{[^{}\s]+\}|${KEY})`, "gu");
const IN_TEXT_LOCATOR = /[ \t]*\[[^[\]@\n]*\]/uy;
const GROUP = /\[([^[\]]*)\]/gu;

function markdownOccurrences(text: string) {
  const masked = proseOnly(text);
  const found: FoundCitation[] = [];
  const groups: Array<readonly [number, number]> = [];
  for (const match of masked.matchAll(GROUP)) {
    const content = match[1]!;
    if (!content.includes("@") || /\n[ \t]*\r?\n/u.test(content)) continue;
    // `\@key` is a literal `@` in Pandoc.
    if (text[match.index + content.indexOf("@")] === "\\") continue;
    const items = pandocCitationItems(content);
    if (items.length === 0) continue;
    const end = match.index + match[0].length;
    groups.push([match.index, end]);
    for (const item of items) found.push({ item, start: match.index, end, listedOnly: false });
  }
  for (const match of masked.matchAll(IN_TEXT)) {
    const start = match.index;
    if (text[start - 1] === "\\" || groups.some(([from, to]) => from <= start && start < to)) {
      continue;
    }
    let end = start + match[0].length;
    IN_TEXT_LOCATOR.lastIndex = end;
    const locator = IN_TEXT_LOCATOR.exec(masked);
    if (locator) end += locator[0].length;
    const [item] = pandocCitationItems(masked.slice(start, end));
    if (item) found.push({ item, start, end, listedOnly: false });
  }
  return found.toSorted((left, right) => left.start - right.start);
}

const LATEX_CITE_NAME = /\\([A-Za-z]*cite[A-Za-z]*)\*?/uy;
const LATEX_NOTE = /\s*\[([^\]]*)\]/uy;
const LATEX_KEYS = /\s*\{([^{}]*)\}/uy;
const LATEX_GLOBAL_NOTE = /\s*\([^()]*\)/uy;

function sticky(pattern: RegExp, text: string, at: number) {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** One citation group at `at`: up to two notes, then the key list. */
function latexGroup(text: string, at: number) {
  const notes: string[] = [];
  let end = at;
  for (let note = sticky(LATEX_NOTE, text, end); note && notes.length < 2;) {
    notes.push(note[1]!);
    end += note[0].length;
    note = sticky(LATEX_NOTE, text, end);
  }
  const keys = sticky(LATEX_KEYS, text, end);
  return keys ? { items: latexCitationItems(keys[1]!, notes), end: end + keys[0].length } : null;
}

function latexOccurrences(text: string) {
  const found: FoundCitation[] = [];
  // The parser places each command; its arguments are read with comments blanked, so a
  // `% comment` between `\cite` and `{key}`, or inside a key list, neither hides nor joins keys.
  const masked = maskLatexComments(text);
  let consumed = 0;
  for (const start of latexCiteOffsets(text)) {
    if (start < consumed) continue;
    const name = sticky(LATEX_CITE_NAME, masked, start);
    if (!name) continue;
    let end = start + name[0].length;
    // biblatex's `\cites(pre)(post)[p.~4]{a}[p.~5]{b}`: each group has its own notes.
    const multi = name[1]!.endsWith("cites");
    if (multi) {
      for (let note = 0; note < 2; note++) {
        const global = sticky(LATEX_GLOBAL_NOTE, masked, end);
        if (global) end += global[0].length;
      }
    }
    const items: CitationItem[] = [];
    for (
      let group = latexGroup(masked, end);
      group;
      group = multi ? latexGroup(masked, end) : null
    ) {
      items.push(...group.items);
      end = group.end;
    }
    if (items.length === 0) continue;
    consumed = end;
    const listedOnly = name[1] === "nocite";
    for (const item of items) found.push({ item, start, end, listedOnly });
  }
  return found;
}

/**
 * Every citation a document makes, in order, each work on its own: `[see @a, p. 4; @b]`,
 * `@a` and `@a [p. 4]` in Markdown prose (not in code, math, links, URLs, HTML or front matter),
 * the `\cite`-family commands of LaTeX outside comments and verbatim text. `\nocite` entries
 * are `listedOnly`.
 */
export function citationOccurrences(
  kind: "markdown" | "latex",
  text: string,
): ReadonlyArray<CitationOccurrence> {
  const starts = lineStarts(text);
  return (kind === "latex" ? latexOccurrences(text) : markdownOccurrences(text)).map(
    ({ item, start, end, listedOnly }) => ({
      ...item,
      start,
      end,
      listedOnly,
      ...locate(starts, start),
    }),
  );
}

const MAX_CONTEXT = 200;

function oneLine(value: string) {
  return value.replace(/\s+/gu, " ");
}

/**
 * The sentence or line around a citation, on one line and about 200 characters at most, with
 * where the citation is in it.
 */
export function citationContext(
  text: string,
  start: number,
  end: number,
): { readonly text: string; readonly start: number; readonly end: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end);
  let before = oneLine(text.slice(lineStart, start)).trimStart();
  const citation = oneLine(text.slice(start, end));
  let after = oneLine(text.slice(end, lineEnd)).trimEnd();
  if (before.length + citation.length + after.length > MAX_CONTEXT) {
    // The sentence: from after the last full stop before the citation to the next one after it.
    const sentenceStart = /^.*[.!?]\s+(?=\p{Lu})/su.exec(before)?.[0].length ?? 0;
    before = before.slice(sentenceStart);
    const sentenceEnd = /[.!?](?=\s+\p{Lu}|$)/u.exec(after);
    if (sentenceEnd) after = after.slice(0, sentenceEnd.index + 1);
  }
  const room = Math.max(0, MAX_CONTEXT - citation.length);
  if (before.length + after.length > room) {
    const keepAfter = Math.min(after.length, Math.max(Math.floor(room / 2), room - before.length));
    const keepBefore = Math.max(0, room - keepAfter);
    if (before.length > keepBefore) {
      const cut = before.slice(before.length - keepBefore);
      before = `…${cut.replace(/^\S*\s/u, "")}`;
    }
    if (after.length > keepAfter) {
      const cut = after.slice(0, keepAfter);
      after = `${cut.replace(/\s\S*$/u, "")}…`;
    }
  }
  return {
    text: before + citation + after,
    start: before.length,
    end: before.length + citation.length,
  };
}
