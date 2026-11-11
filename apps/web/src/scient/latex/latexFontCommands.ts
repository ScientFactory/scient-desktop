import type { Editor } from "@tiptap/core";
import { latexVisualFontMetrics } from "./latexVisualLayout";
import { normalizeFontSize } from "../writing/fontChoices";
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
 * The size in points shared by the whole selection, or null when none or mixed.
 * A named size (`\large`) reports its number for the document's class size.
 */
export function latexFontState(
  editor: Editor | null,
  baseFontPt: 10 | 11 | 12 = 10,
): { readonly size: number | null; readonly family: string | null } {
  if (!editor) return { size: null, family: null };
  const numeric = editor.getAttributes("latexFontSize").points;
  const writtenFamily = editor.getAttributes("latexFontFamily").family;
  const markFamily =
    typeof writtenFamily === "string" && writtenFamily !== "" ? writtenFamily : null;
  if (typeof numeric === "number") return { size: numeric, family: markFamily };
  const named = NAMED_SIZES.find((name) => editor.isActive(`latexSize_${name}`));
  return {
    size: named === undefined ? null : latexVisualFontMetrics(baseFontPt)[named][0],
    family: markFamily,
  };
}

/** A size replaces the previous one, as in LaTeX; null returns to the document default. */
export function setLatexFontSize(editor: Editor | null, points: number | null): boolean {
  if (!editor) return false;
  const size = points === null ? null : normalizeFontSize(points);
  if (points !== null && size === null) return false;
  let chain = editor.chain().focus().unsetMark("latexFontSize");
  for (const name of NAMED_SIZES) chain = chain.unsetMark(`latexSize_${name}`);
  if (size !== null) {
    const leading = Math.round(size * LEADING_RATIO * 100) / 100;
    chain = chain.setMark("latexFontSize", { points: size, leading });
  }
  return chain.run();
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
  let chain = editor
    .chain()
    .focus()
    .unsetMark("latexFontFamily")
    .unsetMark("latexRoman")
    .unsetMark("latexSans");
  if (family !== null) chain = chain.setMark("latexFontFamily", { family, engine });
  return chain.run();
}
