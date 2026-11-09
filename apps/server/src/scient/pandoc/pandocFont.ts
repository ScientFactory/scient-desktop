/**
 * Word export of local font size and family. Scient's recognised `<span style>` forms are turned
 * into Word character styles before raw HTML is stripped; the `font-size` and `font-family`
 * front matter keys set the base font of the reference document.
 */
import {
  MARKDOWN_FONT_FAMILIES,
  MARKDOWN_FONT_SIZES,
  MARKDOWN_FONT_SPAN_CLOSE,
  type MarkdownFontFamilyName,
  type MarkdownFontSpan,
  parseMarkdownFontSpanOpen,
} from "@scientfactory/scient-markdown";
import * as Predicate from "effect/Predicate";

import { attr, customStyleSpan, inlineText, isPandocNode, type PandocNode } from "./pandocAst.ts";
import {
  DEFAULT_WORD_BASE_FONT,
  type WordBaseFont,
  type WordLocalFont,
  wordFontStyleName,
} from "./scientReferenceDocument.ts";

const SPAN_OPEN = /^<span\b/iu;
const BASE_SIZE = /^(10|11|12)pt$/u;

/** The font of a span laid over the font already in force around it. */
function layered(outer: WordLocalFont, span: MarkdownFontSpan): WordLocalFont {
  if ("family" in span) return { ...outer, family: span.family };
  const size = MARKDOWN_FONT_SIZES.find(({ name }) => name === span.size);
  return size === undefined ? outer : { ...outer, em: size.em };
}

/** The raw HTML text of an inline, or null when it is not a raw HTML inline. */
function rawHtml(node: unknown): string | null {
  if (!isPandocNode(node) || node.t !== "RawInline" || !Array.isArray(node.c)) return null;
  const [format, text] = node.c;
  return format === "html" && Predicate.isString(text) ? text.trim() : null;
}

/** Index of the `</span>` that closes the span opened at `open`, counting nested spans. */
function closingIndex(inlines: Array<unknown>, open: number): number {
  let depth = 0;
  for (let index = open; index < inlines.length; index += 1) {
    const html = rawHtml(inlines[index]);
    if (html === null) continue;
    if (SPAN_OPEN.test(html)) depth += 1;
    else if (html.toLowerCase() === MARKDOWN_FONT_SPAN_CLOSE) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function wrapFontSpans(inlines: Array<unknown>, outer: WordLocalFont): void {
  for (let index = 0; index < inlines.length; index += 1) {
    const html = rawHtml(inlines[index]);
    const span = html === null ? null : parseMarkdownFontSpanOpen(html);
    if (span === null) continue;
    const close = closingIndex(inlines, index);
    if (close < 0) continue;
    const font = layered(outer, span);
    const inner = inlines.slice(index + 1, close) as Array<PandocNode>;
    // A Word run carries one character style, so a nested span names the combined font.
    applyFontSpans(inner, font);
    inlines.splice(index, close - index + 1, customStyleSpan(wordFontStyleName(font), inner));
  }
}

/**
 * Replace each recognised size or family span with a Word character style span. Other HTML is
 * left for the raw-HTML strip.
 */
export function applyFontSpans(value: unknown, outer: WordLocalFont = {}): void {
  if (Array.isArray(value)) {
    wrapFontSpans(value, outer);
    for (const item of value) applyFontSpans(item, outer);
    return;
  }
  if (Predicate.isObject(value)) {
    for (const child of Object.values(value)) applyFontSpans(child, outer);
  }
}

function isFontFamilyName(value: string): value is MarkdownFontFamilyName {
  return MARKDOWN_FONT_FAMILIES.some((family) => family === value);
}

/** The base font named by the document's metadata; anything unrecognised keeps the default. */
export function wordBaseFontOf(meta: Record<string, unknown>): WordBaseFont {
  const size = inlineText(meta["font-size"]).trim();
  const family = inlineText(meta["font-family"]).trim();
  return {
    sizePoints: BASE_SIZE.test(size)
      ? Number.parseInt(size, 10)
      : DEFAULT_WORD_BASE_FONT.sizePoints,
    family: isFontFamilyName(family) ? family : DEFAULT_WORD_BASE_FONT.family,
  };
}

// LaTeX source. Pandoc keeps `\textsf` and `\textrm` as classed spans but drops `{\large …}`, so a
// size group is rewritten to a `\textcolor` carrier Pandoc keeps, then turned into the same Word
// style as a Markdown span.

const LATEX_SIZE_COMMAND = new RegExp(
  String.raw`^\\(${MARKDOWN_FONT_SIZES.map(({ name }) => name).join("|")})(?![A-Za-z@])\s?`,
  "u",
);
const LATEX_SIZE_CARRIER = "scient-size-";
const LATEX_SIZE_MACRO = String.raw`\newcommand{\ScientSize}[2]{\textcolor{#1}{#2}}`;
const LATEX_CLASS_SIZE = /\\documentclass\[[^\]]*?\b(10|11|12)pt\b[^\]]*\]/u;
const LATEX_FAMILY_DEFAULT = /\\renewcommand\s*\{\\familydefault\}\s*\{\\(rm|sf|tt)default\}/u;
const LATEX_FAMILIES: Readonly<Record<string, MarkdownFontFamilyName>> = {
  rm: "serif",
  sf: "sans-serif",
  tt: "monospace",
};

const isEscaped = (text: string, index: number): boolean => {
  let backslashes = 0;
  while (index - 1 - backslashes >= 0 && text[index - 1 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
};

/** Index of the `}` closing the `{` at `open`, or -1. Comments and escaped braces are skipped. */
function braceEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "%" && !isEscaped(text, index)) {
      const newline = text.indexOf("\n", index);
      if (newline < 0) return -1;
      index = newline;
    } else if (char === "{" && !isEscaped(text, index)) depth += 1;
    else if (char === "}" && !isEscaped(text, index)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function rewriteSizeGroups(text: string, counter: { found: boolean }): string {
  let out = "";
  let inMath = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "%" && !isEscaped(text, index)) {
      const newline = text.indexOf("\n", index);
      const end = newline < 0 ? text.length : newline;
      out += text.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === "$" && !isEscaped(text, index)) inMath = !inMath;
    if (char === "{" && !inMath && !isEscaped(text, index)) {
      const command = LATEX_SIZE_COMMAND.exec(text.slice(index + 1));
      const end = command === null ? -1 : braceEnd(text, index);
      if (command !== null && end >= 0) {
        counter.found = true;
        const body = text.slice(index + 1 + command[0].length, end);
        out += `\\ScientSize{${LATEX_SIZE_CARRIER}${command[1]}}{${rewriteSizeGroups(body, counter)}}`;
        index = end;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/** The LaTeX source with each `{\large …}` size group made readable by Pandoc. */
export function rewriteLatexSizeGroups(source: string): string {
  const counter = { found: false };
  const rewritten = rewriteSizeGroups(source, counter);
  return counter.found ? `${LATEX_SIZE_MACRO}\n${rewritten}` : source;
}

/** The base font set by the preamble's class option and `\familydefault`, as the Visual card writes them. */
export function latexBaseFontOf(source: string): WordBaseFont {
  const size = LATEX_CLASS_SIZE.exec(source)?.[1];
  const family = LATEX_FAMILY_DEFAULT.exec(source)?.[1];
  return {
    sizePoints: size === undefined ? DEFAULT_WORD_BASE_FONT.sizePoints : Number.parseInt(size, 10),
    family:
      (family === undefined ? undefined : LATEX_FAMILIES[family]) ?? DEFAULT_WORD_BASE_FONT.family,
  };
}

/** The font a Pandoc-read LaTeX span stands for, or null for any other span. */
function latexSpanFont(attributes: unknown): WordLocalFont | null {
  if (!Array.isArray(attributes)) return null;
  const [, classes, pairs] = attributes as [unknown, unknown, unknown];
  if (Array.isArray(classes)) {
    if (classes.includes("sans-serif")) return { family: "sans-serif" };
    if (classes.includes("roman")) return { family: "serif" };
  }
  if (!Array.isArray(pairs)) return null;
  for (const pair of pairs) {
    const style = Array.isArray(pair) && pair[0] === "style" ? pair[1] : null;
    const name = Predicate.isString(style)
      ? new RegExp(`^color:\\s*${LATEX_SIZE_CARRIER}(\\w+)$`, "u").exec(style)?.[1]
      : undefined;
    const size = MARKDOWN_FONT_SIZES.find((entry) => entry.name === name);
    if (size !== undefined) return { em: size.em };
  }
  return null;
}

/** Turn the spans Pandoc made from LaTeX font commands into Word character style spans. */
export function applyLatexFontSpans(value: unknown, outer: WordLocalFont = {}): void {
  if (Array.isArray(value)) {
    for (const item of value) applyLatexFontSpans(item, outer);
    return;
  }
  if (!Predicate.isObject(value)) return;
  if (isPandocNode(value) && value.t === "Span" && Array.isArray(value.c)) {
    const own = latexSpanFont(value.c[0]);
    if (own !== null) {
      const font = { ...outer, ...own };
      applyLatexFontSpans(value.c[1], font);
      value.c[0] = attr([], [["custom-style", wordFontStyleName(font)]]);
      return;
    }
  }
  for (const child of Object.values(value)) applyLatexFontSpans(child, outer);
}
