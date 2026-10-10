import { latexSourceChoices, type LatexSourceChoice } from "./latexCommandCompletion";

export type MathSourceCompletion = LatexSourceChoice;

/** Formula source uses the same templates and argument choices as other LaTeX entry. */
export function mathSourceCompletions(source: string, caret: number, formulaOnly = false) {
  return latexSourceChoices(source, caret, formulaOnly ? "math" : "source");
}
