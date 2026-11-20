import type { ChainedCommands, Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { latexVisualFontMetrics } from "./latexVisualLayout";
import { normalizeFontSize } from "../writing/fontChoices";
import { holdsFont, sharedValue, wordAround } from "../writing/fontTarget";
import { declaredLatexCompiler } from "./latexCompiler";
import { latexFontFamilyDeclaration, type LatexFontEngine } from "./latexTextFormatting";

const NAMED_SIZES = [
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

/** Baseline written with a new size: 1.2 times the size, as the class sizes mostly are. */
const LEADING_RATIO = 1.2;

/**
 * The size and font shared by the whole selection. A value is null when the text has none, and
 * the matching `Mixed` flag is true when the selection holds several. A named size (`\large`)
 * reports its number for the document's class size. Whitespace and code are ignored (`holdsFont`).
 */
export function latexFontState(
  editor: Editor | null,
  baseFontPt: 10 | 11 | 12 = 10,
): {
  readonly size: number | null;
  readonly family: string | null;
  readonly sizeMixed: boolean;
  readonly familyMixed: boolean;
} {
  if (!editor) return { size: null, family: null, sizeMixed: false, familyMixed: false };
  const { selection, doc } = editor.state;
  const sizes = new Set<number | null>();
  const families = new Set<string | null>();
  const read = (marks: ReadonlyArray<Mark>) => {
    const numeric = marks.find((mark) => mark.type.name === "latexFontSize")?.attrs.points;
    const named = NAMED_SIZES.find((name) =>
      marks.some((mark) => mark.type.name === `latexSize_${name}`),
    );
    sizes.add(
      typeof numeric === "number"
        ? numeric
        : named === undefined
          ? null
          : latexVisualFontMetrics(baseFontPt)[named][0],
    );
    const family = marks.find((mark) => mark.type.name === "latexFontFamily")?.attrs.family;
    families.add(typeof family === "string" && family !== "" ? family : null);
  };
  if (selection.empty) read(editor.state.storedMarks ?? selection.$from.marks());
  else {
    doc.nodesBetween(selection.from, selection.to, (node) => {
      if (!node.isText) return;
      if (
        holdsFont(
          node.text ?? "",
          node.marks.some((mark) => mark.type.name === "code"),
        )
      )
        read(node.marks);
    });
  }
  const size = sharedValue(sizes);
  const family = sharedValue(families);
  return {
    size: size.value,
    family: family.value,
    sizeMixed: size.mixed,
    familyMixed: family.mixed,
  };
}

/**
 * Runs a font change on the selection; at a caret it covers the word around it, as in Word,
 * and the caret stays where it was. Between words the change stays with the typing marks.
 */
function runFontChange(
  editor: Editor,
  change: (chain: ChainedCommands) => ChainedCommands,
): boolean {
  const { selection } = editor.state;
  const { $from } = selection;
  const word =
    selection.empty && $from.parent.isTextblock
      ? wordAround(
          $from.parent.textBetween(0, $from.parent.content.size, undefined, "\ufffc"),
          $from.parentOffset,
        )
      : null;
  const chain = editor.chain().focus();
  if (word === null) return change(chain).run();
  const base = $from.start();
  return change(chain.setTextSelection({ from: base + word.start, to: base + word.end }))
    .setTextSelection(selection.from)
    .run();
}

/** A size replaces the previous one, as in LaTeX; null returns to the document default. */
export function setLatexFontSize(editor: Editor | null, points: number | null): boolean {
  if (!editor) return false;
  const size = points === null ? null : normalizeFontSize(points);
  if (points !== null && size === null) return false;
  return runFontChange(editor, (first) => {
    let chain = first.unsetMark("latexFontSize");
    for (const name of NAMED_SIZES) chain = chain.unsetMark(`latexSize_${name}`);
    if (size === null) return chain;
    const leading = Math.round(size * LEADING_RATIO * 100) / 100;
    return chain.setMark("latexFontSize", { points: size, leading });
  });
}

/**
 * The form named fonts are written in: guarded `\fontspec` names when the document is compiled
 * with XeLaTeX, LuaLaTeX or Tectonic or loads `fontspec`, font family codes otherwise (pdfLaTeX).
 */
export function latexFontEngine(setupSource: string): LatexFontEngine {
  const declared = declaredLatexCompiler(setupSource);
  if (declared === "xelatex" || declared === "lualatex" || declared === "tectonic")
    return "fontspec";
  return /^[^%\n]*\\usepackage(?:\[[^\]]*\])?\{[^}]*\bfontspec\b[^}]*\}/mu.test(setupSource)
    ? "fontspec"
    : "pdftex";
}

/** Whether the document's engine can write this font by name. */
export function latexFontAvailable(engine: LatexFontEngine, family: string): boolean {
  return latexFontFamilyDeclaration(engine, family) !== null;
}

/** A font replaces the previous one, as in LaTeX; null returns to the document default. */
export function setLatexFontFamily(
  editor: Editor | null,
  family: string | null,
  engine: LatexFontEngine,
): boolean {
  if (!editor) return false;
  if (family !== null && !latexFontAvailable(engine, family)) return false;
  return runFontChange(editor, (first) => {
    const chain = first.unsetMark("latexFontFamily").unsetMark("latexRoman").unsetMark("latexSans");
    return family === null ? chain : chain.setMark("latexFontFamily", { family, engine });
  });
}
