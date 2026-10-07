import { MATH_COMMANDS } from "../math/input/catalog";
import type { SurfaceBinding } from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";
import type { MathSymbol } from "./mathSymbols";

const structureCommands: Record<string, string> = {
  "Text in math": "text",
  "Boxed expression": "boxed",
  Superscript: "superscript",
  Subscript: "subscript",
  Parentheses: "parentheses",
  Brackets: "brackets",
  Braces: "braces",
  "Absolute value": "absolute",
  Norm: "norm",
  "Angle brackets": "angles",
  "Bracket matrix": "bmatrix",
  "Parentheses matrix": "pmatrix",
  Determinant: "vmatrix",
  Cases: "cases",
  "Aligned equations": "aligned",
};
const aliases: Record<string, string> = {
  "\\to": "\\rightarrow",
  "\\le": "\\leq",
  "\\ge": "\\geq",
  "\\ne": "\\neq",
};
const canonicalCommand = (tex: string) => {
  const command = /^\\[A-Za-z]+/u.exec(tex)?.[0] ?? tex;
  return aliases[command] ?? command;
};

/** Read effective bindings, including user overrides and disabled bindings. */
export function mathSymbolShortcuts(
  symbol: MathSymbol,
  bindings: readonly SurfaceBinding[],
): string[] {
  const command = structureCommands[symbol.label];
  const ids =
    command && symbol.category === "structures"
      ? [`math.${command}`]
      : MATH_COMMANDS.filter(
          (entry) =>
            entry.completion &&
            canonicalCommand(`\\${entry.completion}`) === canonicalCommand(symbol.command),
        ).map((entry) => entry.id);
  const hints = bindings
    .filter((binding) => ids.includes(binding.command))
    .map((binding) => labelKeys(binding.keys));
  return [...new Set(hints)];
}
