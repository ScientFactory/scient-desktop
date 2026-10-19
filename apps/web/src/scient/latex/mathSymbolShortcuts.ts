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

// The built-in catalog is immutable. Resolve its completion aliases once,
// rather than scanning and normalizing every command for every palette symbol.
const completionIds = new Map<string, string[]>();
for (const entry of MATH_COMMANDS) {
  if (!entry.completion) continue;
  const command = canonicalCommand(`\\${entry.completion}`);
  const ids = completionIds.get(command) ?? [];
  ids.push(entry.id);
  completionIds.set(command, ids);
}

type BindingHint = { index: number; label: string };
const bindingHints = new WeakMap<readonly SurfaceBinding[], Map<string, BindingHint[]>>();
function hintsByCommand(bindings: readonly SurfaceBinding[]) {
  const cached = bindingHints.get(bindings);
  if (cached) return cached;
  const hints = new Map<string, BindingHint[]>();
  bindings.forEach((binding, index) => {
    const entries = hints.get(binding.command) ?? [];
    entries.push({ index, label: labelKeys(binding.keys) });
    hints.set(binding.command, entries);
  });
  bindingHints.set(bindings, hints);
  return hints;
}

/** Read effective bindings, including user overrides and disabled bindings. */
export function mathSymbolShortcuts(
  symbol: MathSymbol,
  bindings: readonly SurfaceBinding[],
): string[] {
  const command = structureCommands[symbol.label];
  const ids =
    command && symbol.category === "structures"
      ? [`math.${command}`]
      : (completionIds.get(canonicalCommand(symbol.command)) ?? []);
  const hints = hintsByCommand(bindings);
  // Preserve effective-binding order when several command aliases match.
  const labels = ids
    .flatMap((id) => hints.get(id) ?? [])
    .sort((a, b) => a.index - b.index)
    .map((hint) => hint.label);
  return [...new Set(labels)];
}
