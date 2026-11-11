/**
 * Word export of local font size and family. Scient's recognised `<span style>` forms are turned
 * into Word character styles before raw HTML is stripped; the `fontsize` and `mainfont` front
 * matter keys set the base font of the reference document.
 */
import {
  DOCUMENT_FONT_SIZES,
  MARKDOWN_FONT_SPAN_CLOSE,
  type MarkdownFontSpan,
  catalogueFont,
  normalizeFontSize,
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
const BASE_SIZE = new RegExp(`^(${DOCUMENT_FONT_SIZES.join("|")})$`, "u");

/** The base font of the document, and the local fonts used, which the reference document defines. */
export interface FontPass {
  readonly base: WordBaseFont;
  readonly used: Map<string, WordLocalFont>;
}

/** The Word style name for a font, noting it so the reference document defines it. */
function styleNameOf(font: WordLocalFont, pass: FontPass): string {
  const name = wordFontStyleName(font);
  pass.used.set(name, font);
  return name;
}

/** The font of a span laid over the font already in force around it. */
function layered(outer: WordLocalFont, span: MarkdownFontSpan): WordLocalFont {
  return "family" in span ? { ...outer, family: span.family } : { ...outer, size: span.size };
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

function wrapFontSpans(inlines: Array<unknown>, outer: WordLocalFont, pass: FontPass): void {
  for (let index = 0; index < inlines.length; index += 1) {
    const html = rawHtml(inlines[index]);
    const span = html === null ? null : parseMarkdownFontSpanOpen(html);
    if (span === null) continue;
    const close = closingIndex(inlines, index);
    if (close < 0) continue;
    const font = layered(outer, span);
    const inner = inlines.slice(index + 1, close) as Array<PandocNode>;
    // A Word run carries one character style, so a nested span names the combined font.
    applyFontSpans(inner, pass, font);
    inlines.splice(index, close - index + 1, customStyleSpan(styleNameOf(font, pass), inner));
  }
}

/**
 * Replace each recognised size or family span with a Word character style span. Other HTML is
 * left for the raw-HTML strip.
 */
export function applyFontSpans(value: unknown, pass: FontPass, outer: WordLocalFont = {}): void {
  if (Array.isArray(value)) {
    wrapFontSpans(value, outer, pass);
    for (const item of value) applyFontSpans(item, pass, outer);
    return;
  }
  if (!Predicate.isObject(value)) return;
  for (const child of Object.values(value)) applyFontSpans(child, pass, outer);
}

/** The base font named by the document's metadata; anything unrecognised keeps the default. */
export function wordBaseFontOf(meta: Record<string, unknown>): WordBaseFont {
  const size = inlineText(meta["fontsize"]).trim();
  const family = inlineText(meta["mainfont"]).trim();
  return {
    sizePoints: BASE_SIZE.test(size)
      ? Number.parseInt(size, 10)
      : DEFAULT_WORD_BASE_FONT.sizePoints,
    family: catalogueFont(family) === null ? DEFAULT_WORD_BASE_FONT.family : family,
  };
}

// LaTeX source. Pandoc keeps `\textsf` and `\textrm` as classed spans but drops `{\large …}`, so a
// size group is rewritten to a `\textcolor` carrier Pandoc keeps, then turned into the same Word
// style as a Markdown span.

// Sizes of the standard class commands, in points, for the 10, 11 and 12 pt class options
// (the same table as the Visual editor's layout).
const LATEX_NAMED_SIZES: Readonly<Record<string, readonly [number, number, number]>> = {
  tiny: [5, 6, 6],
  scriptsize: [7, 8, 8],
  footnotesize: [8, 9, 10],
  small: [9, 10, 10.95],
  normalsize: [10, 10.95, 12],
  large: [12, 12, 14.4],
  Large: [14.4, 14.4, 17.28],
  LARGE: [17.28, 17.28, 20.74],
  huge: [20.74, 20.74, 24.88],
  Huge: [24.88, 24.88, 24.88],
};
const LATEX_SIZE_COMMAND = new RegExp(
  String.raw`^\\(?:(${Object.keys(LATEX_NAMED_SIZES).join("|")})|fontsize\{(\d+(?:\.\d+)?)\}\{[^{}]*\}\\selectfont)(?:\{\}|(?![A-Za-z@])\s?)`,
  "u",
);
const LATEX_SIZE_CARRIER = "scient-size-";
const LATEX_SIZE_MACRO = String.raw`\newcommand{\ScientSize}[2]{\textcolor{#1}{#2}}`;
const LATEX_CLASS_SIZE = new RegExp(
  String.raw`\\documentclass\[[^\]]*?\b(${DOCUMENT_FONT_SIZES.join("|")})\b[^\]]*\]`,
  "u",
);
const LATEX_FAMILY_DEFAULT = /\\renewcommand\s*\{\\familydefault\}\s*\{\\(rm|sf|tt)default\}/u;
const LATEX_FAMILIES: Readonly<Record<string, string>> = {
  rm: "Times New Roman",
  sf: "Arial",
  tt: "Courier New",
};

/** The source without its comments, so commented lines are never read as settings. */
const withoutComments = (source: string): string => source.replaceAll(/(?<!\\)%.*$/gmu, "");

/** The class option size, 10 when absent (LaTeX's own default). */
function latexClassSize(source: string): 10 | 11 | 12 {
  const option = LATEX_CLASS_SIZE.exec(withoutComments(source))?.[1];
  return option === "11pt" ? 11 : option === "12pt" ? 12 : 10;
}

/** The size in points of a matched size command: a `\fontsize` number or a named class size. */
function latexCommandPoints(command: RegExpExecArray, classSize: 10 | 11 | 12): number | null {
  const named = command[1];
  if (named !== undefined) return LATEX_NAMED_SIZES[named]?.[classSize - 10] ?? null;
  return normalizeFontSize(Number(command[2]));
}

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

// Environments whose content is copied as is.
const LATEX_VERBATIM_START = /^\\begin\{(verbatim\*?|lstlisting|minted)\}/u;
// A brace right after a command name or a closing bracket is that command's argument, not a group.
const LATEX_ARGUMENT_BEFORE = /[A-Za-z}\]*@]/u;

function rewriteSizeGroups(
  text: string,
  counter: { found: boolean },
  classSize: 10 | 11 | 12,
): string {
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
    if (char === "\\" && !isEscaped(text, index)) {
      const verbatim = LATEX_VERBATIM_START.exec(text.slice(index));
      if (verbatim !== null) {
        const close = `\\end{${verbatim[1]}}`;
        const end = text.indexOf(close, index);
        const stop = end < 0 ? text.length : end + close.length;
        out += text.slice(index, stop);
        index = stop - 1;
        continue;
      }
      const next = text[index + 1];
      if (next === "(" || next === "[") inMath = true;
      else if (next === ")" || next === "]") inMath = false;
    }
    if (char === "$" && !isEscaped(text, index)) inMath = !inMath;
    const standalone = index === 0 || !LATEX_ARGUMENT_BEFORE.test(text[index - 1] ?? "");
    if (char === "{" && standalone && !inMath && !isEscaped(text, index)) {
      const command = LATEX_SIZE_COMMAND.exec(text.slice(index + 1));
      const end = command === null ? -1 : braceEnd(text, index);
      const points = command === null ? null : latexCommandPoints(command, classSize);
      if (command !== null && points !== null && end >= 0) {
        counter.found = true;
        const body = text.slice(index + 1 + command[0].length, end);
        const carrier = `${LATEX_SIZE_CARRIER}${String(points).replace(".", "p")}`;
        out += `\\ScientSize{${carrier}}{${rewriteSizeGroups(body, counter, classSize)}}`;
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
  const rewritten = rewriteSizeGroups(source, counter, latexClassSize(source));
  return counter.found ? `${LATEX_SIZE_MACRO}\n${rewritten}` : source;
}

/** The base font set by the preamble's class option and `\familydefault`, as the Visual card writes them. */
export function latexBaseFontOf(source: string): WordBaseFont {
  const active = withoutComments(source);
  const size = LATEX_CLASS_SIZE.exec(active)?.[1];
  const family = LATEX_FAMILY_DEFAULT.exec(active)?.[1];
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
    if (classes.includes("sans-serif")) return { family: LATEX_FAMILIES["sf"] ?? "Arial" };
    if (classes.includes("roman")) return { family: LATEX_FAMILIES["rm"] ?? "Times New Roman" };
  }
  if (!Array.isArray(pairs)) return null;
  for (const pair of pairs) {
    const style = Array.isArray(pair) && pair[0] === "style" ? pair[1] : null;
    const carried = Predicate.isString(style)
      ? new RegExp(`^color:\\s*${LATEX_SIZE_CARRIER}(\\d+(?:p\\d+)?)$`, "u").exec(style)?.[1]
      : undefined;
    if (carried !== undefined) return { size: Number(carried.replace("p", ".")) };
  }
  return null;
}

/** Turn the spans Pandoc made from LaTeX font commands into Word character style spans. */
export function applyLatexFontSpans(
  value: unknown,
  pass: FontPass,
  outer: WordLocalFont = {},
): void {
  if (Array.isArray(value)) {
    for (const item of value) applyLatexFontSpans(item, pass, outer);
    return;
  }
  if (!Predicate.isObject(value)) return;
  if (isPandocNode(value) && value.t === "Span" && Array.isArray(value.c)) {
    const own = latexSpanFont(value.c[0]);
    if (own !== null) {
      const font = { ...outer, ...own };
      applyLatexFontSpans(value.c[1], pass, font);
      value.c[0] = attr([], [["custom-style", styleNameOf(font, pass)]]);
      return;
    }
  }
  for (const child of Object.values(value)) applyLatexFontSpans(child, pass, outer);
}
