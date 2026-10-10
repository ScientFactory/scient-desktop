import type { MathEdit, MathSelection } from "../math/input/catalog";

export interface CustomMathCommand {
  readonly id: string;
  readonly label: string;
  /** Literal LaTeX, with optional ${selection} and ${cursor} markers. */
  readonly latex: string;
}

export function validateCustomMath(value: unknown): readonly CustomMathCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Use at most 100 custom math actions.");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      !("label" in entry) ||
      !("latex" in entry) ||
      typeof entry.id !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.latex !== "string" ||
      !/^math\.custom\.[a-z0-9-]+$/u.test(entry.id) ||
      ids.has(entry.id) ||
      !entry.label.trim() ||
      entry.label.length > 100 ||
      !entry.latex.trim() ||
      entry.latex.length > 8000
    )
      throw new Error("Invalid custom math action. Supply a name and a LaTeX expression.");
    if (
      /\\(?:documentclass|usepackage|input|include|write|openout|read|def|newcommand|renewcommand)\b/u.test(
        entry.latex,
      ) ||
      /\\(?:begin|end)\{document\}/u.test(entry.latex)
    )
      throw new Error(
        "Math actions contain expressions. Put document setup and macro definitions in the preamble.",
      );
    ids.add(entry.id);
    return { id: entry.id, label: entry.label.trim(), latex: entry.latex };
  });
}

export function customMathEdit(
  command: CustomMathCommand,
  source: string,
  selection: MathSelection,
): MathEdit {
  const selected = source.slice(selection.from, selection.to);
  let insert = "";
  let cursor: number | undefined;
  // Resolve markers in the template only; selected text is always literal.
  for (const part of command.latex.split(/(\$\{selection\}|\$\{cursor\})/u)) {
    if (part === "${selection}") insert += selected;
    else if (part === "${cursor}") cursor ??= insert.length;
    else insert += part;
  }
  const position = selection.from + (cursor ?? insert.length);
  return { ...selection, insert, selection: { from: position, to: position } };
}
