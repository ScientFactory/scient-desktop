import {
  FONT_CATALOGUE,
  catalogueFont,
  normalizeFontSize,
} from "@scientfactory/scient-markdown/fonts";
import { LATEX_DIRECTION_MARKS, latexDirectionMark } from "./latexLanguage";

/** Text styles understood by both the source adapter and the editable canvas. */
const LATEX_TEXT_SIZES = [
  "tiny",
  "scriptsize",
  "footnotesize",
  "small",
  "normalsize",
  "large",
  "Large",
  "LARGE",
  "huge",
  "Huge",
] as const;

export const LATEX_INLINE_MARKS: Readonly<Record<string, string>> = {
  textbf: "bold",
  textit: "italic",
  emph: "italic",
  texttt: "code",
  textsc: "latexSmallCaps",
  underline: "underline",
  textrm: "latexRoman",
  textsf: "latexSans",
  textsl: "latexSlanted",
  textup: "latexUpright",
  textmd: "latexMedium",
  ...Object.fromEntries(LATEX_DIRECTION_MARKS.map(({ command, name }) => [command, name])),
};

const LATEX_TEXT_DECLARATIONS: Readonly<Record<string, string>> = {
  bfseries: "bold",
  mdseries: "latexMedium",
  itshape: "italic",
  slshape: "latexSlanted",
  upshape: "latexUpright",
  scshape: "latexSmallCaps",
  ttfamily: "code",
  rmfamily: "latexRoman",
  sffamily: "latexSans",
  ...Object.fromEntries(LATEX_TEXT_SIZES.map((size) => [size, `latexSize_${size}`])),
};

/**
 * A numeric size is one mark whose key carries its values (`latexFontSize:12/14.4`:
 * size and baseline in points), so the parser can keep working on plain string marks.
 */
const FONT_SIZE_MARK = "latexFontSize";

function latexFontSizeMark(points: number, leading?: number): string {
  return `${FONT_SIZE_MARK}:${points}/${leading ?? Math.round(points * 1.2 * 100) / 100}`;
}

/**
 * A named font is one mark whose key carries the catalogue name and the form it is written in
 * (`latexFontFamily:pdftex:Times New Roman`), so the same bytes are written back on save.
 */
const FONT_FAMILY_MARK = "latexFontFamily";

/** pdfLaTeX writes a font family code; XeLaTeX and LuaLaTeX write a guarded `\fontspec` name. */
export type LatexFontEngine = "pdftex" | "fontspec";

function latexFontFamilyMark(engine: LatexFontEngine, family: string): string {
  return `${FONT_FAMILY_MARK}:${engine}:${family}`;
}

type LatexMarkNode = { type: string; attrs?: Record<string, number | string> };

/** The ProseMirror mark a string mark stands for. */
export function latexMarkNode(key: string): LatexMarkNode {
  const size = new RegExp(`^${FONT_SIZE_MARK}:([\\d.]+)/([\\d.]+)$`, "u").exec(key);
  if (size)
    return { type: FONT_SIZE_MARK, attrs: { points: Number(size[1]), leading: Number(size[2]) } };
  const font = new RegExp(`^${FONT_FAMILY_MARK}:(pdftex|fontspec):(.+)$`, "u").exec(key);
  return font
    ? { type: FONT_FAMILY_MARK, attrs: { engine: font[1]!, family: font[2]! } }
    : { type: key };
}

/** The string mark key of a ProseMirror mark: the inverse of `latexMarkNode`. */
export function latexMarkKey(mark: { type: string; attrs?: Record<string, unknown> }): string {
  if (mark.type === FONT_FAMILY_MARK)
    return latexFontFamilyMark(
      mark.attrs?.engine === "fontspec" ? "fontspec" : "pdftex",
      String(mark.attrs?.family),
    );
  return mark.type === FONT_SIZE_MARK
    ? latexFontSizeMark(Number(mark.attrs?.points), Number(mark.attrs?.leading))
    : mark.type;
}

const SIMPLE_DECLARATION = /^\\([A-Za-z]+)(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u;
const FONT_SIZE_DECLARATION =
  /^\\fontsize\s*\{\s*([\d.]+)\s*(?:pt)?\s*\}\s*\{\s*([\d.]+)\s*(?:pt)?\s*\}\s*\\selectfont(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u;
const FONT_FAMILY_CODE_DECLARATION =
  /^\\fontfamily\{([a-z0-9]+)\}\\selectfont(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u;
const FONT_FAMILY_NAME_DECLARATION =
  /^\\IfFontExistsTF\{([^{}]+)\}\{\\fontspec\{\1\}\}\{\\fontspec\{([^{}]+)\}\}(?:\{\}|[\t\r\n ]*)/u;

/** The fonts used when a named font is missing under XeLaTeX or LuaLaTeX: Latin Modern, always installed. */
const FALLBACK_FONT: Readonly<Record<string, string>> = {
  serif: "Latin Modern Roman",
  "sans-serif": "Latin Modern Sans",
  monospace: "Latin Modern Mono",
};

/** The declaration that selects a catalogue font, or null when the form does not offer it. */
export function latexFontFamilyDeclaration(engine: LatexFontEngine, family: string): string | null {
  const font = catalogueFont(family);
  if (!font) return null;
  if (engine === "pdftex")
    return font.latex.pdftex === null ? null : `\\fontfamily{${font.latex.pdftex}}\\selectfont`;
  const fallback = FALLBACK_FONT[font.category]!;
  return `\\IfFontExistsTF{${font.latex.fontspec}}{\\fontspec{${font.latex.fontspec}}}{\\fontspec{${fallback}}}`;
}

/** A text style declaration at the start of `source`: `\large`, `\ttfamily`, `\fontsize{12}{14.4}\selectfont`. */
export function latexTextDeclarationAt(source: string): { mark: string; length: number } | null {
  const size = FONT_SIZE_DECLARATION.exec(source);
  if (size) {
    const points = normalizeFontSize(Number(size[1]));
    const leading = Number(size[2]);
    return points === null || !(leading > 0 && leading <= 150)
      ? null
      : { mark: latexFontSizeMark(points, leading), length: size[0].length };
  }
  const code = FONT_FAMILY_CODE_DECLARATION.exec(source);
  if (code) {
    const font = FONT_CATALOGUE.find((entry) => entry.latex.pdftex === code[1]);
    return font ? { mark: latexFontFamilyMark("pdftex", font.name), length: code[0].length } : null;
  }
  const named = FONT_FAMILY_NAME_DECLARATION.exec(source);
  if (named) {
    const font = FONT_CATALOGUE.find((entry) => entry.latex.fontspec === named[1]);
    const written = font && latexFontFamilyDeclaration("fontspec", font.name);
    return font && named[0].startsWith(written ?? "\0")
      ? { mark: latexFontFamilyMark("fontspec", font.name), length: named[0].length }
      : null;
  }
  const simple = SIMPLE_DECLARATION.exec(source);
  const mark = simple ? LATEX_TEXT_DECLARATIONS[simple[1]!] : undefined;
  return simple && mark !== undefined ? { mark, length: simple[0].length } : null;
}

/** Source of a group around already serialised text; `{}` after the declaration keeps a leading space. */
function declarationGroup(declaration: string, text: string): string {
  return `{${declaration}${/^\s/u.test(text) ? "{}" : " "}${text}}`;
}

/** Source of the group a size or font-family ProseMirror mark stands for. */
export function latexFontGroupSource(
  mark: { type: string; attrs?: Record<string, unknown> },
  text: string,
): string {
  if (mark.type === FONT_FAMILY_MARK) {
    const engine = mark.attrs?.engine === "fontspec" ? "fontspec" : "pdftex";
    const declaration = latexFontFamilyDeclaration(engine, String(mark.attrs?.family));
    return declaration === null ? text : declarationGroup(declaration, text);
  }
  return declarationGroup(
    `\\fontsize{${Number(mark.attrs?.points)}}{${Number(mark.attrs?.leading)}}\\selectfont`,
    text,
  );
}

export const LATEX_CANVAS_TEXT_MARKS = [
  { name: "latexSmallCaps", style: "small-caps" },
  { name: "latexRoman", style: "roman" },
  { name: "latexSans", style: "sans" },
  { name: "latexSlanted", style: "slanted" },
  { name: "latexUpright", style: "upright" },
  { name: "latexMedium", style: "medium" },
  ...LATEX_TEXT_SIZES.map((size) => ({ name: `latexSize_${size}`, style: size })),
];

function markGroup(mark: string): string {
  if (latexDirectionMark(mark)) return "direction";
  if (mark.startsWith("latexSize_") || mark.startsWith(`${FONT_SIZE_MARK}:`)) return "size";
  if (mark.startsWith(`${FONT_FAMILY_MARK}:`)) return "family";
  if (["code", "latexRoman", "latexSans"].includes(mark)) return "family";
  if (["italic", "latexSlanted", "latexUpright", "latexSmallCaps"].includes(mark)) return "shape";
  if (["bold", "latexMedium"].includes(mark)) return "weight";
  return mark;
}

export function withLatexTextMark(marks: readonly string[], mark: string): readonly string[] {
  return [...marks.filter((existing) => markGroup(existing) !== markGroup(mark)), mark];
}

export function latexTextMarkSource(mark: string, text: string): string {
  if (mark.startsWith("latexSize_")) {
    const size = mark.slice("latexSize_".length);
    if (LATEX_TEXT_SIZES.some((known) => known === size)) return `{\\${size} ${text}}`;
  }
  if (mark === "italic") return `\\emph{${text}}`;
  const command = Object.entries(LATEX_INLINE_MARKS).find(([, type]) => type === mark)?.[0];
  return command ? `\\${command}{${text}}` : text;
}
