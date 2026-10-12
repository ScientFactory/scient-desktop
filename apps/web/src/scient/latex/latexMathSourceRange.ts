import { matrixAt } from "../math/input/matrix";
import { mathRowSourceRange } from "./latexMathNumbering";
import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";

/** Read authored cells at the clicked grid path; ambiguous grids keep their enclosing range. */
export function latexMathSourceRange(
  source: string,
  path: readonly {
    environment: string;
    row: number;
    rows: number;
    column: number;
    columns: number;
  }[],
  selectedText: string,
) {
  let scope = { from: 0, to: source.length };
  for (const [index, cell] of path.entries()) {
    const raw = source.slice(scope.from, scope.to);
    const row =
      index === 0
        ? mathRowSourceRange(raw, cell.row, cell.rows, cell.environment, {
            column: cell.column,
            columns: cell.columns,
          })
        : null;
    if (row) {
      scope = { from: scope.from + row.from, to: scope.from + row.to };
      continue;
    }
    const grids = latexSourceCommands(raw).flatMap((command) => {
      if (command.name !== "begin") return [];
      const argument = latexSourceArgument(raw, command.to);
      if (argument?.value !== cell.environment) return [];
      const grid = matrixAt(raw, argument.end);
      return grid?.environment === cell.environment &&
        grid.rows.length === cell.rows &&
        grid.rows.every((row) => row.length === cell.columns)
        ? [grid]
        : [];
    });
    if (grids.length !== 1) return null;
    const owned = grids[0]!.rows[cell.row]?.[cell.column];
    if (!owned) return null;
    scope = { from: scope.from + owned.from, to: scope.from + owned.to };
  }
  const raw = source.slice(scope.from, scope.to);
  const text = selectedText.trim();
  if (text) {
    const commands = latexSourceCommands(raw);
    const matches: number[] = [];
    for (let at = raw.indexOf(text); at >= 0; at = raw.indexOf(text, at + 1))
      if (!commands.some((command) => at > command.from && at < command.to)) matches.push(at);
    if (matches.length === 1)
      return { from: scope.from + matches[0]!, to: scope.from + matches[0]! + text.length };
  }
  if (!path.length) return null;
  return {
    from: scope.from + raw.length - raw.trimStart().length,
    to: scope.to - (raw.length - raw.trimEnd().length),
  };
}
