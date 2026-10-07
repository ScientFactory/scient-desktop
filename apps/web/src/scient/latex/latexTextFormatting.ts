import { LATEX_DIRECTION_MARKS, latexDirectionMark } from "./latexLanguage";

/** Text styles understood by both the source adapter and the editable canvas. */
export const LATEX_TEXT_SIZES = [
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

export const LATEX_TEXT_DECLARATIONS: Readonly<Record<string, string>> = {
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
  if (mark.startsWith("latexSize_")) return "size";
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
