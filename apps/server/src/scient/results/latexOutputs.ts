/**
 * Plain LaTeX made from a run's outputs: a `\newcommand` per value and a booktabs `tabular` per
 * CSV table. The files carry no Scient syntax, so they compile anywhere, Overleaf included.
 */

const DIGIT_WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

const MAXIMUM_TABLE_ROWS = 500;
const MAXIMUM_TABLE_COLUMNS = 40;

/** ASCII letters only, as LaTeX command names allow; digits are spelled out. */
function letterWords(text: string): ReadonlyArray<string> {
  const words: string[] = [];
  for (const match of text.matchAll(/[A-Za-z]+|[0-9]/gu)) {
    const word = match[0];
    words.push(/^[0-9]$/u.test(word) ? DIGIT_WORDS[Number(word)]! : word);
  }
  return words;
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** `survival.py`, `values.json`, `/cohort/n` → `resultSurvivalCohortN` (without the backslash). */
export function defaultMacroName(scriptPath: string, output: string, pointer: string): string {
  const script = scriptPath
    .split("/")
    .at(-1)!
    .replace(/\.[^.]*$/u, "");
  const file = output
    .split("/")
    .at(-1)!
    .replace(/\.[^.]*$/u, "");
  const parts = [
    ...letterWords(script),
    // The usual values file adds nothing to the name; a second values file must.
    ...(file === "values" ? [] : letterWords(file)),
    ...letterWords(pointer),
  ];
  return `result${parts.map(capitalize).join("") || "Value"}`;
}

/** A name not in `taken`, adding B, C, … (letters only) when the plain name is used. */
export function uniqueMacroName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let index = 1; index < 26 * 26; index += 1) {
    const suffix =
      index < 26
        ? String.fromCharCode(65 + index)
        : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
    if (!taken.has(`${name}${suffix}`)) return `${name}${suffix}`;
  }
  throw new Error(`No free name for \\${name}.`);
}

const LATEX_TEXT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
  "<": "\\textless{}",
  ">": "\\textgreater{}",
  "−": "\\textminus{}",
};

/**
 * Text as LaTeX prints it. Plain numbers come through unchanged, so `\num{\resultSurvivalHr}`
 * still works with siunitx.
 */
export function escapeLatexText(text: string): string {
  return text.replace(/[\\&%$#_{}~^<>−]/gu, (character) => LATEX_TEXT_ESCAPES[character]!);
}

const generatedHeader = (scriptPath: string, revision: string, finishedAt: string) =>
  [
    `% Made by Scient from ${scriptPath}, run ${revision} (${finishedAt}).`,
    "% Change the script, not this file: Update files in Scient replaces it with a newer run.",
  ].join("\n");

export function valuesTexFile(input: {
  readonly scriptPath: string;
  readonly revision: string;
  readonly finishedAt: string;
  readonly values: ReadonlyArray<{ readonly macro: string; readonly value: string }>;
}): string {
  const lines = input.values.map(
    (value) => `\\newcommand{\\${value.macro}}{${escapeLatexText(value.value)}}`,
  );
  return `${generatedHeader(input.scriptPath, input.revision, input.finishedAt)}\n${lines.join("\n")}\n`;
}

/** RFC 4180 rows, or null for text that is not a table Scient will print. */
export function parseCsv(text: string): ReadonlyArray<ReadonlyArray<string>> | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"' && cell === "") quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > MAXIMUM_TABLE_ROWS) return null;
    } else cell += character;
  }
  if (quoted) return null;
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const width = rows[0]?.length ?? 0;
  if (
    rows.length < 1 ||
    width < 1 ||
    width > MAXIMUM_TABLE_COLUMNS ||
    rows.length > MAXIMUM_TABLE_ROWS
  )
    return null;
  // A ragged table is a different file format; Scient does not guess its columns.
  return rows.every((candidate) => candidate.length === width) ? rows : null;
}

const NUMBER_CELL = /^\s*[+\-−]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*%?\s*$/u;

/**
 * A booktabs `tabular` with the CSV's cells exactly as the script wrote them. Numeric columns are
 * right-aligned; the first row is the header.
 */
export function csvTabularFile(input: {
  readonly scriptPath: string;
  readonly revision: string;
  readonly finishedAt: string;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}): string {
  const [header, ...body] = input.rows;
  const columns = header!.map((_, column) =>
    body.length > 0 &&
    body.every((row) => row[column]!.trim() === "" || NUMBER_CELL.test(row[column]!))
      ? "r"
      : "l",
  );
  const line = (row: ReadonlyArray<string>) =>
    `${row.map((cell) => escapeLatexText(cell.trim())).join(" & ")} \\\\`;
  return [
    generatedHeader(input.scriptPath, input.revision, input.finishedAt),
    `\\begin{tabular}{${columns.join("")}}`,
    "\\toprule",
    line(header!),
    "\\midrule",
    ...body.map(line),
    "\\bottomrule",
    "\\end{tabular}",
    "",
  ].join("\n");
}

/** `table1.csv` → `table1`, safe in a `\label` and a file name. */
export function outputSlug(output: string): string {
  const stem = output
    .split("/")
    .at(-1)!
    .replace(/\.[^.]*$/u, "");
  return (
    stem
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase() || "result"
  );
}
