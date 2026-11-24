import {
  latexSourceCommands,
  latexSourceArgument,
  latexPreambleEnd,
  latexVisualFontMetrics,
  GUARDED_MAIN_FONT,
} from "@scientfactory/scient-document/latex";
/**
 * Word export of local font size and family. Scient's recognised `<span style>` forms are turned
 * into Word character styles before raw HTML is stripped; the `fontsize` and `mainfont` front
 * matter keys set the base font of the reference document.
 */
import {
  DOCUMENT_FONT_SIZES,
  MARKDOWN_FONT_SPAN_CLOSE,
  type MarkdownFontSpan,
  FONT_CATALOGUE,
  catalogueFont,
  fontForLatexCode,
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
  readonly readLatexCarriers?: boolean;
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
  // Runs in a link keep the link's look, which a character style would otherwise replace.
  const within = isPandocNode(value) && value.t === "Link" ? { ...outer, link: true } : outer;
  for (const child of Object.values(value)) applyFontSpans(child, pass, within);
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

const CLASS_METRICS = {
  10: latexVisualFontMetrics(10),
  11: latexVisualFontMetrics(11),
  12: latexVisualFontMetrics(12),
};
const LATEX_SIZE_COMMAND = new RegExp(
  String.raw`^\\(?:(${Object.keys(CLASS_METRICS[10]).join("|")})|fontsize\s*\{\s*(\d+(?:\.\d+)?)\s*(?:pt)?\s*\}\s*\{[^{}]*\}\s*\\selectfont)(?:\{\}|(?![A-Za-z@])\s?)`,
  "u",
);
const LATEX_SIZE_CARRIER = "scient-size-";
const LATEX_SIZE_MACRO = String.raw`\newcommand{\ScientSize}[2]{\textcolor{#1}{#2}}`;
const LATEX_FAMILY_DEFAULT = /\\renewcommand\s*\{\\familydefault\}\s*\{\\?([A-Za-z0-9]+)\}/gu;
const LATEX_MAIN_FONT = /\\setmainfont\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/gu;
const LATEX_FAMILIES: Readonly<Record<string, string>> = {
  rm: "Times New Roman",
  sf: "Arial",
  tt: "Courier New",
};

/** Read only commands that execute in the document preamble. */
function fontPreamble(source: string) {
  const text = source.slice(0, latexPreambleEnd(source));
  const commands = latexSourceCommands(text).filter((command) => command.depth === 0);
  const active = new Set(commands.map((command) => command.from));
  const last = (pattern: RegExp) =>
    [...text.matchAll(pattern)].findLast((match) => active.has(match.index));
  const cls = commands.find((command) => command.name === "documentclass");
  const options =
    cls &&
    latexSourceArgument(text, cls.to, "[", "]")
      ?.value.split(",")
      .map((value) => value.trim());
  const size = options?.findLast((value) => ["10pt", "11pt", "12pt"].includes(value));
  const classSize = size === "12pt" ? 12 : size === "11pt" ? 11 : 10;
  return { last, classSize } as const;
}

const LATEX_FONT_CARRIER = "scient-font-";
const LATEX_FONT_CODE = /^\\fontfamily\{([a-z0-9]+)\}\\selectfont(?:\{\}|(?![A-Za-z@])\s?)/u;
const LATEX_FONT_NAME =
  /^\\IfFontExistsTF\{([^{}]+)\}\{\\fontspec\{\1\}\}\{\\fontspec\{[^{}]+\}\}(?:\{\}|\s?)/u;

/** The carrier colour name and length of a size or font declaration at the start of `rest`. */
function latexDeclaration(
  rest: string,
  classSize: 10 | 11 | 12,
): { readonly carrier: string; readonly length: number } | null {
  const command = LATEX_SIZE_COMMAND.exec(rest);
  if (command !== null) {
    const named = command[1];
    const points =
      named === undefined
        ? normalizeFontSize(Number(command[2]))
        : (CLASS_METRICS[classSize][named as keyof (typeof CLASS_METRICS)[10]]?.[0] ?? null);
    return points === null
      ? null
      : {
          carrier: `${LATEX_SIZE_CARRIER}${String(points).replace(".", "p")}`,
          length: command[0].length,
        };
  }
  const code = LATEX_FONT_CODE.exec(rest);
  const named = code === null ? LATEX_FONT_NAME.exec(rest) : null;
  const index = FONT_CATALOGUE.findIndex((font) =>
    code === null
      ? font.latex.fontspec === named?.[1]
      : font.name === fontForLatexCode(code[1])?.name,
  );
  const match = code ?? named;
  return match === null || index < 0
    ? null
    : { carrier: `${LATEX_FONT_CARRIER}${index}`, length: match[0].length };
}

// A literal brace, a formula or a verbatim example must never delimit an export rewrite.
const OPAQUE_ENVIRONMENT =
  /^\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment|math|displaymath|equation\*?|align(?:at)?\*?|flalign\*?|gather\*?|multline\*?|eqnarray\*?)\}/u;
const INLINE_LITERAL = /^\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)([^\sA-Za-z*])/u;

export function rewriteLatexSizeGroups(source: string): string {
  if (/\\ScientSize\b|scient-(?:size|font)-/u.test(source)) return source;
  const { classSize } = fontPreamble(source);
  const groups: Array<{
    start: number;
    declaration: ReturnType<typeof latexDeclaration>;
    opaqueCount: number;
  }> = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let opaqueCount = 0;
  let mathEnd = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "%") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (mathEnd && source.startsWith(mathEnd, i)) {
      i += mathEnd.length - 1;
      mathEnd = "";
      continue;
    }
    if (c === "\\") {
      const rest = source.slice(i);
      const env = OPAQUE_ENVIRONMENT.exec(rest);
      if (env) {
        const name = env[1]!.replace("*", "\\*");
        const close = new RegExp("\\\\end\\s*\\{" + name + "\\}", "gu");
        close.lastIndex = i + env[0].length;
        if (!close.exec(source)) return source;
        i = close.lastIndex - 1;
        opaqueCount++;
        continue;
      }
      const literal = INLINE_LITERAL.exec(rest);
      if (literal) {
        const delimiter = literal[1]!;
        let end = i + literal[0].length;
        if (delimiter === "{" && rest.startsWith("\\lstinline")) {
          let depth = 1;
          while (end < source.length && depth) {
            if (source[end] === "{") depth++;
            if (source[end] === "}") depth--;
            end++;
          }
          if (depth) return source;
          i = end - 1;
        } else {
          i = source.indexOf(delimiter, end);
          if (i < 0) return source;
        }
        opaqueCount++;
        continue;
      }
      const next = source[i + 1];
      if (!mathEnd && (next === "(" || next === "[")) {
        mathEnd = next === "(" ? "\\)" : "\\]";
        opaqueCount++;
      }
      i++;
      continue;
    }
    if (mathEnd) continue;
    if (c === "$") {
      mathEnd = source[i + 1] === "$" ? "$$" : "$";
      i += mathEnd.length - 1;
      opaqueCount++;
    } else if (c === "{") {
      const declaration = latexDeclaration(source.slice(i + 1), classSize);
      groups.push({ start: i + 1, declaration, opaqueCount });
      if (declaration) i += declaration.length;
    } else if (c === "}") {
      const group = groups.pop();
      if (!group) return source;
      if (group.declaration && group.opaqueCount === opaqueCount) {
        edits.push({
          start: group.start,
          end: group.start + group.declaration.length,
          text: "\\ScientSize{" + group.declaration.carrier + "}{",
        });
        edits.push({ start: i, end: i, text: "}" });
      }
    }
  }
  if (groups.length || mathEnd || !edits.length) return source;
  let from = 0;
  const chunks = [LATEX_SIZE_MACRO, "\n"];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    chunks.push(source.slice(from, edit.start), edit.text);
    from = edit.end;
  }
  chunks.push(source.slice(from));
  return chunks.join("");
}

/**
 * The base font set by the preamble, as the Visual card writes it: the class option size (10 pt
 * when absent) and the active family. An explicit \familydefault selects the text family;
 * \setmainfont names the face used when the roman family is active.
 */
export function latexBaseFontOf(source: string): WordBaseFont {
  const { last, classSize } = fontPreamble(source);
  const familyDefault = last(LATEX_FAMILY_DEFAULT)?.[1];
  const mainFont = [last(LATEX_MAIN_FONT), last(GUARDED_MAIN_FONT)]
    .filter((m) => m !== undefined)
    .sort((a, b) => a.index - b.index)
    .at(-1)?.[1]
    ?.trim();
  const generic = familyDefault?.match(/^(rm|sf|tt)default$/u)?.[1];
  const family =
    (generic === "sf" || generic === "tt" ? LATEX_FAMILIES[generic] : undefined) ??
    fontForLatexCode(familyDefault)?.name ??
    catalogueFont(mainFont ?? "")?.name ??
    (generic === "rm" ? LATEX_FAMILIES["rm"] : undefined);
  return {
    sizePoints: classSize,
    family: family ?? DEFAULT_WORD_BASE_FONT.family,
  };
}

/** The font a Pandoc-read LaTeX span stands for, or null for any other span. */
function latexSpanFont(attributes: unknown, readCarriers: boolean): WordLocalFont | null {
  if (!Array.isArray(attributes)) return null;
  const [, classes, pairs] = attributes as [unknown, unknown, unknown];
  if (Array.isArray(classes)) {
    if (classes.includes("sans-serif")) return { family: LATEX_FAMILIES["sf"] ?? "Arial" };
    if (classes.includes("roman")) return { family: LATEX_FAMILIES["rm"] ?? "Times New Roman" };
  }
  if (!readCarriers || !Array.isArray(pairs)) return null;
  for (const pair of pairs) {
    const style = Array.isArray(pair) && pair[0] === "style" ? pair[1] : null;
    const carried = Predicate.isString(style)
      ? new RegExp(`^color:\\s*${LATEX_SIZE_CARRIER}(\\d+(?:p\\d+)?)$`, "u").exec(style)?.[1]
      : undefined;
    if (carried !== undefined) return { size: Number(carried.replace("p", ".")) };
    const font = Predicate.isString(style)
      ? new RegExp(`^color:\\s*${LATEX_FONT_CARRIER}(\\d+)$`, "u").exec(style)?.[1]
      : undefined;
    const family = font === undefined ? undefined : FONT_CATALOGUE[Number(font)]?.name;
    if (family !== undefined) return { family };
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
    const own = latexSpanFont(value.c[0], pass.readLatexCarriers !== false);
    if (own !== null) {
      const font = { ...outer, ...own };
      applyLatexFontSpans(value.c[1], pass, font);
      value.c[0] = attr([], [["custom-style", styleNameOf(font, pass)]]);
      return;
    }
  }
  const within = isPandocNode(value) && value.t === "Link" ? { ...outer, link: true } : outer;
  for (const child of Object.values(value)) applyLatexFontSpans(child, pass, within);
}
