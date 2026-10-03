import { MATH_COMMANDS } from "../math/input/catalog";
import { commandKeys, type KeyboardPreferences } from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";
import { MATH_TYPING_SHORTCUTS } from "./mathTypingShortcuts";
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
  preferences: KeyboardPreferences,
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
  const hints = ids.flatMap((id) => commandKeys(id).map((keys) => labelKeys(keys)));
  if (symbol.action) hints.push(symbol.action === "moveToSuperscript" ? "Type ^" : "Type _");
  if (preferences.automaticOperators) {
    for (const [keys, tex] of Object.entries(MATH_TYPING_SHORTCUTS)) {
      if (canonicalCommand(tex) === canonicalCommand(symbol.command)) hints.push(`Type ${keys}`);
    }
  }
  return [...new Set(hints)];
}
