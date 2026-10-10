import { MATRIX_ENVIRONMENTS } from "../math/input/matrix";
import { MATH_SYMBOLS } from "./mathSymbols";
import { MATH_FORMATTING_ARGUMENTS } from "./mathTextFormatting";
import { latexCommandChoices, type LatexCompletionContext } from "./latexCommandCompletion";

export interface MathCommandCompletion {
  readonly label: string;
  readonly latex: string;
  readonly argument?: boolean;
  readonly text?: boolean;
  readonly preview?: string;
}

export function mathCommandCompletions(query: string, context: LatexCompletionContext = {}) {
  if (/^\\beg(?:i(?:n)?)?$/u.test(query))
    return [
      { label: "\\begin{}", latex: "\\begin{}", preview: "\\begin{environment}", argument: true },
    ];
  const environments = mathEnvironmentCompletions(query);
  if (environments.length)
    return environments.map((choice) => ({
      ...choice,
      preview: choice.latex.replace(/#\?/gu, "").replace(/\s+/gu, " "),
    }));
  return latexCommandChoices(query, "math", context);
}

const argumentTemplates = new Map(
  MATH_SYMBOLS.filter(
    (symbol) =>
      /^\\[A-Za-z]+$/u.test(symbol.command) &&
      symbol.latex.startsWith(`${symbol.command}{`) &&
      /#[0-9?]/u.test(symbol.latex),
  ).map((symbol) => [symbol.command, symbol.latex.replace(/#[0-9?]/gu, "#?")]),
);
for (const command of Object.keys(MATH_FORMATTING_ARGUMENTS))
  argumentTemplates.set(`\\${command}`, `\\${command}{#?}`);

/** Complete only an explicit command, without replacing an argument already written. */
export function mathArgumentCompletion(command: string): MathCommandCompletion | null {
  const match = /^(\\[A-Za-z]+)(?:\{\})?$/u.exec(command);
  if (!match) return null;
  const latex = argumentTemplates.get(match[1]!);
  return latex
    ? {
        label: match[1]!,
        latex,
        text: MATH_FORMATTING_ARGUMENTS[match[1]!.slice(1)] === "text",
      }
    : null;
}

/** Formula environments only: display wrappers are changed through the Math menu. */
export function mathEnvironmentCompletions(beforeCaret: string): MathCommandCompletion[] {
  if (/^\\beg(?:i(?:n)?)?$/u.test(beforeCaret))
    return [{ label: "\\begin{}", latex: "\\begin{}", argument: true }];
  const match = /^\\begin\{([A-Za-z*]*)\}?$/u.exec(beforeCaret);
  if (!match) return [];
  return MATRIX_ENVIRONMENTS.filter((name) => name.startsWith(match[1]!)).map((name) => ({
    label: `\\begin{${name}}`,
    latex: `\\begin{${name}}#? & #? \\\\ #? & #?\\end{${name}}`,
  }));
}
