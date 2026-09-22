import type { MathEdit, MathSelection } from "./catalog";

export const MATRIX_ENVIRONMENTS = [
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "aligned",
] as const;
export type MatrixEnvironment = (typeof MATRIX_ENVIRONMENTS)[number];
export type MatrixAction =
  | "next"
  | "previous"
  | "addRow"
  | "deleteRow"
  | "copyRow"
  | "swapRow"
  | "addColumn"
  | "deleteColumn"
  | "copyColumn"
  | "swapColumn";
interface Cell {
  readonly from: number;
  readonly to: number;
}
interface Matrix {
  readonly environment: string;
  readonly from: number;
  readonly to: number;
  readonly rows: readonly (readonly Cell[])[];
}

/** Parse delimiters only at the matrix's own grouping/environment depth.
 * Unknown row options/rules and malformed matrices are deliberately not rewritten. */
export function matrixAt(source: string, position: number): Matrix | null {
  const stack: { name: string; start: number }[] = [];
  const candidates: Matrix[] = [];
  const env = /\\(begin|end)\{([A-Za-z*]+)\}/gu;
  for (const token of source.matchAll(env)) {
    let slashCount = 0;
    for (let i = token.index! - 1; i >= 0 && source[i] === "\\"; i--) slashCount++;
    if (slashCount % 2 === 1) continue;
    const lineStart = source.lastIndexOf("\n", token.index!) + 1;
    if (/(?<!\\)%/u.test(source.slice(lineStart, token.index!))) continue;
    const name = token[2]!;
    if (token[1] === "begin") stack.push({ name, start: token.index! + token[0].length });
    else {
      const opening = stack.pop();
      if (!opening || opening.name !== name) return null;
      if (
        !MATRIX_ENVIRONMENTS.includes(name as MatrixEnvironment) ||
        position < opening.start ||
        position > token.index!
      )
        continue;
      const rows = parseCells(source, opening.start, token.index!);
      if (rows) candidates.push({ environment: name, from: opening.start, to: token.index!, rows });
    }
  }
  return candidates.sort((a, b) => a.to - a.from - (b.to - b.from))[0] ?? null;
}

function parseCells(source: string, from: number, to: number): readonly (readonly Cell[])[] | null {
  const rows: Cell[][] = [[]];
  let start = from;
  let braces = 0;
  let environments = 0;
  for (let i = from; i < to; i++) {
    const char = source[i];
    if (char === "%") return null;
    if (char === "\\") {
      const env = /^\\(begin|end)\{([A-Za-z*]+)\}/u.exec(source.slice(i, to));
      if (env) {
        environments += env[1] === "begin" ? 1 : -1;
        i += env[0].length - 1;
        continue;
      }
      if (source[i + 1] === "\\" && braces === 0 && environments === 0) {
        if (/^\s*\[/u.test(source.slice(i + 2, to))) return null;
        rows.at(-1)!.push({ from: start, to: i });
        rows.push([]);
        start = i + 2;
      } else if (/^\\(?:hline|cline|multicolumn|omit|cr|noalign)\b/u.test(source.slice(i)))
        return null;
      i++;
    } else if (char === "{") braces++;
    else if (char === "}") {
      if (--braces < 0) return null;
    } else if (char === "&" && braces === 0 && environments === 0) {
      rows.at(-1)!.push({ from: start, to: i });
      start = i + 1;
    }
  }
  if (braces !== 0 || environments !== 0) return null;
  rows.at(-1)!.push({ from: start, to });
  const columns = rows[0]!.length;
  if (rows.length > 20 || columns > 20 || rows.some((row) => row.length !== columns)) return null;
  return rows;
}

export function insertMatrix(
  selection: MathSelection,
  environment: MatrixEnvironment,
  rows: number,
  columns: number,
): MathEdit | null {
  if (
    !MATRIX_ENVIRONMENTS.includes(environment) ||
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    columns < 1 ||
    rows > 20 ||
    columns > 20
  )
    return null;
  if ((environment === "cases" || environment === "aligned") && columns !== 2) return null;
  const prefix = `\\begin{${environment}}\n`;
  const body = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => "{}").join(" & "),
  ).join(" \\\\\n");
  const insert = `${prefix}${body}\n\\end{${environment}}`;
  const caret = selection.from + prefix.length + 1;
  return { ...selection, insert, selection: { from: caret, to: caret } };
}

function cellSelection(source: string, cell: Cell): MathSelection {
  const text = source.slice(cell.from, cell.to);
  const from = cell.from + text.length - text.trimStart().length;
  if (text.trim() === "{}") return { from: from + 1, to: from + 1 };
  return { from, to: cell.to - (text.length - text.trimEnd().length) };
}

export function matrixEdit(
  source: string,
  selection: MathSelection,
  action: MatrixAction,
): MathEdit | null {
  const matrix = matrixAt(source, selection.from);
  if (!matrix || selection.to > matrix.to) return null;
  const cells = matrix.rows.flat();
  const index = cells.findIndex((cell) => selection.from >= cell.from && selection.to <= cell.to);
  if (index < 0) return null;
  if (action === "next" || action === "previous") {
    const target = cells[index + (action === "next" ? 1 : -1)];
    if (!target) return null;
    return {
      from: selection.from,
      to: selection.from,
      insert: "",
      selection: cellSelection(source, target),
    };
  }
  const rows = matrix.rows.map((row) => row.map((cell) => source.slice(cell.from, cell.to).trim()));
  const columns = rows[0]!.length;
  let rowIndex = Math.floor(index / columns);
  let columnIndex = index % columns;
  switch (action) {
    case "addRow":
    case "copyRow":
      if (rows.length >= 20) return null;
      rows.splice(
        rowIndex + 1,
        0,
        action === "copyRow" ? [...rows[rowIndex]!] : Array.from({ length: columns }, () => "{}"),
      );
      rowIndex++;
      break;
    case "deleteRow":
      if (rows.length === 1) return null;
      rows.splice(rowIndex, 1);
      rowIndex = Math.min(rowIndex, rows.length - 1);
      break;
    case "swapRow":
      if (rowIndex + 1 === rows.length) return null;
      [rows[rowIndex], rows[rowIndex + 1]] = [rows[rowIndex + 1]!, rows[rowIndex]!];
      rowIndex++;
      break;
    case "addColumn":
    case "copyColumn":
      if (columns >= 20 || matrix.environment === "cases" || matrix.environment === "aligned")
        return null;
      for (const row of rows)
        row.splice(columnIndex + 1, 0, action === "copyColumn" ? row[columnIndex]! : "{}");
      columnIndex++;
      break;
    case "deleteColumn":
      if (columns === 1 || matrix.environment === "cases" || matrix.environment === "aligned")
        return null;
      for (const row of rows) row.splice(columnIndex, 1);
      columnIndex = Math.min(columnIndex, columns - 2);
      break;
    case "swapColumn":
      if (columnIndex + 1 === columns) return null;
      for (const row of rows)
        [row[columnIndex], row[columnIndex + 1]] = [row[columnIndex + 1]!, row[columnIndex]!];
      columnIndex++;
      break;
    default:
      return null;
  }
  const insert = `\n${rows.map((row) => row.join(" & ")).join(" \\\\\n")}\n`;
  const updated = source.slice(0, matrix.from) + insert + source.slice(matrix.to);
  const target = matrixAt(updated, matrix.from)?.rows[rowIndex]?.[columnIndex];
  if (!target) return null;
  return { from: matrix.from, to: matrix.to, insert, selection: cellSelection(updated, target) };
}
