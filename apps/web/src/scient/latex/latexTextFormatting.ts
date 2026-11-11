import { normalizeFontSize } from "@scientfactory/scient-markdown";
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

/** The ProseMirror mark a string mark stands for. */
export function latexMarkNode(key: string): { type: string; attrs?: Record<string, number> } {
  const size = new RegExp(`^${FONT_SIZE_MARK}:([\\d.]+)/([\\d.]+)$`, "u").exec(key);
  return size
    ? { type: FONT_SIZE_MARK, attrs: { points: Number(size[1]), leading: Number(size[2]) } }
    : { type: key };
}

/** The string mark key of a ProseMirror mark: the inverse of `latexMarkNode`. */
export function latexMarkKey(mark: { type: string; attrs?: Record<string, unknown> }): string {
  return mark.type === FONT_SIZE_MARK
    ? latexFontSizeMark(Number(mark.attrs?.points), Number(mark.attrs?.leading))
    : mark.type;
}

const SIMPLE_DECLARATION = /^\\([A-Za-z]+)(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u;
const FONT_SIZE_DECLARATION =
  /^\\fontsize\s*\{\s*([\d.]+)\s*(?:pt)?\s*\}\s*\{\s*([\d.]+)\s*(?:pt)?\s*\}\s*\\selectfont(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u;

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
  const simple = SIMPLE_DECLARATION.exec(source);
  const mark = simple ? LATEX_TEXT_DECLARATIONS[simple[1]!] : undefined;
  return simple && mark !== undefined ? { mark, length: simple[0].length } : null;
}

/** Source of a size group around already serialised text; `\selectfont{}` keeps a leading space. */
export function latexFontSizeGroupSource(points: number, leading: number, text: string): string {
  const separator = /^\s/u.test(text) ? "{}" : " ";
  return `{\\fontsize{${points}}{${leading}}\\selectfont${separator}${text}}`;
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
