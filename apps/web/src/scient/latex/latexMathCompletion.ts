const MATH_SOURCE_COMMANDS = [
  ["frac", "\\frac{}{}"],
  ["sqrt", "\\sqrt{}"],
  ["sum", "\\sum_{}^{}"],
  ["prod", "\\prod_{}^{}"],
  ["int", "\\int_{}^{}"],
  ["lim", "\\lim_{}"],
  ["alpha", "\\alpha"],
  ["beta", "\\beta"],
  ["gamma", "\\gamma"],
  ["theta", "\\theta"],
  ["lambda", "\\lambda"],
  ["pi", "\\pi"],
  ["sigma", "\\sigma"],
  ["phi", "\\phi"],
  ["omega", "\\omega"],
  ["infty", "\\infty"],
] as const;

const MATH_SOURCE_ENVIRONMENTS = [
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "bmatrix",
  "pmatrix",
  "cases",
  "aligned",
] as const;

export interface MathSourceCompletion {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly replacement: string;
}

export function mathSourceCompletions(source: string, caret: number): MathSourceCompletion[] {
  const before = source.slice(0, caret);
  const environment = /\\begin\{([A-Za-z*]*)$/u.exec(before);
  if (environment) {
    const query = environment[1]!;
    const from = caret - environment[0].length;
    return MATH_SOURCE_ENVIRONMENTS.filter((name) => name.startsWith(query)).map((name) => ({
      from,
      to: caret,
      label: `\\begin{${name}}`,
      replacement: `\\begin{${name}}\n\n\\end{${name}}`,
    }));
  }
  const command = /\\([A-Za-z]*)$/u.exec(before);
  if (!command) return [];
  const query = command[1]!;
  if (query.length === 0) return [];
  const from = caret - command[0].length;
  return MATH_SOURCE_COMMANDS.filter(([name]) => name.startsWith(query)).map(
    ([name, replacement]) => ({ from, to: caret, label: `\\${name}`, replacement }),
  );
}
