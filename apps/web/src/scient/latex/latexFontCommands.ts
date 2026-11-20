import type { ChainedCommands, Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { latexVisualFontMetrics } from "./latexVisualLayout";
import { drawnPointsAt, normalizeFontSize } from "../writing/fontChoices";
import { holdsFont, sharedValue, steppedFontSize, wordAround } from "../writing/fontTarget";
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

/** The size of a run in points: its numeric size, or its named size for the class size. */
function latexRunSize(marks: ReadonlyArray<Mark>, baseFontPt: 10 | 11 | 12): number | null {
  const numeric = marks.find((mark) => mark.type.name === "latexFontSize")?.attrs.points;
  if (typeof numeric === "number") return numeric;
  const named = NAMED_SIZES.find((name) =>
    marks.some((mark) => mark.type.name === `latexSize_${name}`),
  );
  return named === undefined ? null : latexVisualFontMetrics(baseFontPt)[named][0];
}

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
    sizes.add(latexRunSize(marks, baseFontPt));
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

/** The word around an empty selection, as document positions, or null. */
function caretWord(editor: Editor): { from: number; to: number } | null {
  const { selection } = editor.state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock) return null;
  const text = $from.parent.textBetween(0, $from.parent.content.size, undefined, "\ufffc");
  const word = wordAround(text, $from.parentOffset);
  return word === null ? null : { from: $from.start() + word.start, to: $from.start() + word.end };
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
  const word = caretWord(editor);
  const chain = editor.chain().focus();
  if (word === null) return change(chain).run();
  return change(chain.setTextSelection(word)).setTextSelection(selection.from).run();
}

/** The size mark written for a size in points, with its baseline. */
const sizeAttributes = (points: number) => ({
  points,
  leading: Math.round(points * LEADING_RATIO * 100) / 100,
});

/** A size replaces the previous one, as in LaTeX; null returns to the document default. */
export function setLatexFontSize(editor: Editor | null, points: number | null): boolean {
  if (!editor) return false;
  const size = points === null ? null : normalizeFontSize(points);
  if (points !== null && size === null) return false;
  return runFontChange(editor, (first) => {
    let chain = first.unsetMark("latexFontSize");
    for (const name of NAMED_SIZES) chain = chain.unsetMark(`latexSize_${name}`);
    return size === null ? chain : chain.setMark("latexFontSize", sizeAttributes(size));
  });
}

/**
 * Moves the size of every run of the selection (or of the word at the caret) by `steps` steps;
 * each run keeps its difference with the others. Text without a size starts from the size it is
 * drawn at, so a heading word grows from the heading's size.
 */
export function stepLatexFontSize(
  editor: Editor | null,
  steps: number,
  baseFontPt: 10 | 11 | 12,
): boolean {
  if (!editor) return false;
  const { state, view } = editor;
  const word = caretWord(editor);
  if (state.selection.empty && word === null) {
    const current =
      latexRunSize(state.storedMarks ?? state.selection.$from.marks(), baseFontPt) ??
      drawnPointsAt(view, state.selection.from);
    return current !== null && setLatexFontSize(editor, steppedFontSize(current, steps));
  }
  const ranges = word
    ? [word]
    : state.selection.ranges.map((range) => ({ from: range.$from.pos, to: range.$to.pos }));
  const sizeMarks = ["latexFontSize", ...NAMED_SIZES.map((name) => `latexSize_${name}`)];
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      for (const range of ranges) {
        state.doc.nodesBetween(range.from, range.to, (node, position) => {
          if (!node.isText || node.marks.some((mark) => mark.type.name === "code")) return;
          const own = latexRunSize(node.marks, baseFontPt);
          if (own === null && !holdsFont(node.text ?? "", false)) return;
          // Like a size applied to a selection, the group leaves out the spaces at its ends.
          const text = node.text ?? "";
          let from = Math.max(range.from, position);
          let to = Math.min(range.to, position + node.nodeSize);
          while (from < to && /\s/u.test(text[from - position] ?? "")) from += 1;
          while (to > from && /\s/u.test(text[to - position - 1] ?? "")) to -= 1;
          const current = own ?? drawnPointsAt(view, from);
          if (current === null) return;
          for (const name of sizeMarks) tr.removeMark(from, to, state.schema.marks[name]);
          tr.addMark(
            from,
            to,
            state.schema.marks["latexFontSize"]!.create(
              sizeAttributes(steppedFontSize(current, steps)),
            ),
          );
        });
      }
      return true;
    })
    .run();
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
