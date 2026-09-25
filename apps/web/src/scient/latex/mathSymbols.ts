import catalog from "./mathSymbolCatalog.json";

export interface MathSymbol {
  id: string;
  category: string;
  label: string;
  command: string;
  latex: string;
  preview: string;
  glyph?: string;
  packages: readonly string[];
  search: string;
  action?: "moveToSuperscript" | "moveToSubscript";
}

// Command membership and Unicode/package facts were checked against LyX's
// lib/ui/stdtoolbars.inc and lib/symbols (2026-09-24). The UI, insertion templates
// and search vocabulary here are Scient's. No LyX icons or implementation code.
export const MATH_SYMBOL_CATEGORIES = [
  ["structures", "Structures", "√"],
  ["latex_greek", "Greek letters", "α"],
  ["latex_bop", "Operators", "±"],
  ["latex_brel", "Relations & logic", "≤"],
  ["latex_arrow", "Arrows", "→"],
  ["latex_varsz", "Large operators", "∑"],
  ["latex_deco", "Accents & decorations", "â"],
  ["latex_delim", "Delimiters", "[ ]"],
  ["functions", "Functions", "sin"],
  ["frac-square", "Fractions & binomials", "½"],
  ["sqrt-square", "Roots", "√"],
  ["font", "Math alphabets", "ℝ"],
  ["latex_dots", "Dots", "⋯"],
  ["space", "Spacing", "↔"],
  ["style", "Styles & classes", "Aa"],
  ["latex_misc", "Other symbols", "∞"],
  ["latex_ams_arrows", "Extended arrows", "⇢"],
  ["latex_ams_ops", "Extended operators", "⊞"],
  ["latex_ams_rel", "Extended relations", "≲"],
  ["latex_ams_nrel", "Negated relations", "≰"],
  ["latex_ams_misc", "Specialist symbols", "♮"],
] as const;

const names: Record<string, string> = {
  frac: "Fraction",
  dfrac: "Display fraction",
  tfrac: "Inline fraction",
  cfrac: "Continued fraction",
  sqrt: "Square root",
  root: "Indexed root",
  binom: "Binomial coefficient",
  sum: "Summation",
  prod: "Product",
  coprod: "Coproduct",
  int: "Integral",
  iint: "Double integral",
  iiint: "Triple integral",
  oint: "Contour integral",
  lim: "Limit",
  infty: "Infinity",
  leq: "Less than or equal",
  geq: "Greater than or equal",
  neq: "Not equal",
  approx: "Approximately equal",
  equiv: "Equivalent",
  in: "Element of",
  ni: "Contains element",
  notin: "Not an element",
  forall: "For all",
  exists: "There exists",
  nexists: "Does not exist",
  emptyset: "Empty set",
  varnothing: "Empty set variant",
  subset: "Subset",
  subseteq: "Subset or equal",
  supset: "Superset",
  supseteq: "Superset or equal",
  cap: "Intersection",
  cup: "Union",
  land: "Logical and",
  lor: "Logical or",
  lnot: "Logical not",
  neg: "Negation",
  nabla: "Gradient nabla",
  partial: "Partial derivative",
  times: "Multiplication",
  div: "Division",
  cdot: "Dot product",
  pm: "Plus or minus",
  mp: "Minus or plus",
  rightarrow: "Right arrow",
  leftarrow: "Left arrow",
  leftrightarrow: "Left right arrow",
  Rightarrow: "Implies",
  Leftarrow: "Implied by",
  Leftrightarrow: "If and only if",
  mapsto: "Maps to",
  hat: "Hat accent",
  bar: "Bar accent",
  vec: "Vector accent",
  dot: "Dot accent",
  ddot: "Double dot accent",
  overline: "Overline",
  underline: "Underline",
  overbrace: "Overbrace",
  underbrace: "Underbrace",
  mathbb: "Blackboard bold",
  mathds: "Double stroke",
  mathcal: "Calligraphic",
  mathfrak: "Fraktur",
  mathscr: "Script",
  mathrm: "Upright roman",
  mathbf: "Bold",
  boldsymbol: "Bold symbol",
  mathsf: "Sans serif",
  mathit: "Italic",
  mathtt: "Monospace",
  textrm: "Text in math",
  ldots: "Horizontal dots",
  cdots: "Centered dots",
  vdots: "Vertical dots",
  ddots: "Diagonal dots",
  iddots: "Ascending diagonal dots",
  quad: "Em space",
  qquad: "Double em space",
  ",": "Thin space",
  ":": "Medium space",
  ";": "Thick space",
  "!": "Negative thin space",
};

// #0 wraps the selected expression; an empty selection becomes an editable slot.
const templates: Record<string, string> = {
  frac: "\\frac{#0}{}",
  dfrac: "\\dfrac{#0}{}",
  tfrac: "\\tfrac{#0}{}",
  cfrac: "\\cfrac{#0}{}",
  cfracleft: "\\cfrac[l]{#0}{}",
  cfracright: "\\cfrac[r]{#0}{}",
  sqrt: "\\sqrt{#0}",
  root: "\\sqrt[]{#0}",
  binom: "\\binom{#0}{}",
  tbinom: "\\tbinom{#0}{}",
  dbinom: "\\dbinom{#0}{}",
  nicefrac: "\\nicefrac{#0}{}",
  unitone: "\\unit{#0}",
  unittwo: "\\unit[]{#0}",
  unitfrac: "\\unitfrac{#0}{}",
  unitfracthree: "\\unitfrac[]{#0}{}",
  smasht: "\\smash[t]{#0}",
  smashb: "\\smash[b]{#0}",
  overset: "\\overset{}{#0}",
  underset: "\\underset{}{#0}",
  stackrel: "\\stackrel{}{#0}",
  stackrelthree: "\\overset{}{\\underset{}{#0}}",
  cancelto: "\\cancelto{}{#0}",
  sideset: "\\sideset{_{}^{}}{_{}^{}}{#0}",
  sidesetl: "\\sideset{_{}^{}}{}{#0}",
  sidesetr: "\\sideset{}{_{}^{}}{#0}",
  sidesetn: "\\sideset{}{}{#0}",
  xleftarrow: "\\xleftarrow{#0}",
  xrightarrow: "\\xrightarrow{#0}",
  not: "\\not{#0}",
  mathcircumflex: "\\text{\\textasciicircum}",
  mathdollar: "\\text{\\$}",
  mathparagraph: "\\text{\\P}",
  mathsection: "\\text{\\S}",
  textdegree: "{}^{\\circ}",
};

const packageOverrides: Record<string, string[]> = {
  int: [],
  intop: [],
  oint: [],
  ointop: [],
  iint: ["amsmath"],
  iiint: ["amsmath"],
  iiiint: ["amsmath"],
  mathbb: ["amssymb"],
  mathfrak: ["amssymb"],
  idotsint: ["amsmath"],
  mathds: ["dsfont"],
  mathscr: ["mathrsfs"],
  utilde: ["undertilde"],
  nicefrac: ["nicefrac"],
  unitone: ["units"],
  unittwo: ["units"],
  unitfrac: ["units"],
  unitfracthree: ["units"],
  mathllap: ["mathtools"],
  mathclap: ["mathtools"],
  mathrlap: ["mathtools"],
  cancel: ["cancel"],
  bcancel: ["cancel"],
  xcancel: ["cancel"],
  cancelto: ["cancel"],
  mathcircumflex: ["amsmath"],
  mathdollar: ["amsmath"],
  mathparagraph: ["amsmath"],
  mathsection: ["amsmath"],
  textdegree: [],
};

function fromCatalog(row: (typeof catalog)[number]): MathSymbol {
  const name = /^\\([A-Za-z]+|.)/u.exec(row.command)?.[1] ?? row.command;
  const simple = row.command === `\\${name}`;
  let latex = simple ? (templates[name] ?? row.command) : row.command;
  if (simple && !templates[name]) {
    if (
      ["font", "latex_deco"].includes(row.category) ||
      /^(?:phantom|hphantom|vphantom|smash|mathllap|mathclap|mathrlap|mathrel|mathbin|mathop|mathord)$/u.test(
        name,
      )
    )
      latex += "{#0}";
    else if (row.category === "style") latex = `{${latex} #0}`;
  }
  const packages =
    packageOverrides[name] ??
    row.packages ??
    (["frac-square", "latex_deco", "font"].includes(row.category) ? ["amsmath"] : []);
  const label = simple ? (names[name] ?? name) : row.command.replaceAll("\\", "");
  const categoryLabel = MATH_SYMBOL_CATEGORIES.find(([id]) => id === row.category)?.[1] ?? "";
  return {
    id: `${row.category}:${row.command}`,
    category: row.category,
    command: row.command,
    label,
    latex,
    preview: latex
      .replaceAll("#0", row.category === "font" ? "A" : "x")
      .replaceAll("{}", "{\\square}"),
    glyph: row.glyph,
    packages,
    search: `${label} ${row.command} ${row.glyph ?? ""} ${categoryLabel}`.toLowerCase(),
  };
}

const structures: [string, string, string][] = [
  ["Superscript", "{#0}^{}", "x^2"],
  ["Subscript", "{#0}_{}", "x_i"],
  ["Parentheses", "\\left(#0\\right)", "(x)"],
  ["Brackets", "\\left[#0\\right]", "[x]"],
  ["Braces", "\\left\\{#0\\right\\}", "\\{x\\}"],
  ["Absolute value", "\\left|#0\\right|", "|x|"],
  ["Norm", "\\left\\lVert#0\\right\\rVert", "\\lVert x\\rVert"],
  ["Angle brackets", "\\left\\langle#0\\right\\rangle", "\\langle x\\rangle"],
  ["Floor", "\\left\\lfloor#0\\right\\rfloor", "\\lfloor x\\rfloor"],
  ["Ceiling", "\\left\\lceil#0\\right\\rceil", "\\lceil x\\rceil"],
  ["Matrix", "\\begin{matrix}#0 & \\\\ & \\end{matrix}", "\\begin{matrix}a&b\\\\c&d\\end{matrix}"],
  [
    "Bracket matrix",
    "\\begin{bmatrix}#0 & \\\\ & \\end{bmatrix}",
    "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}",
  ],
  [
    "Parentheses matrix",
    "\\begin{pmatrix}#0 & \\\\ & \\end{pmatrix}",
    "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
  ],
  [
    "Determinant",
    "\\begin{vmatrix}#0 & \\\\ & \\end{vmatrix}",
    "\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}",
  ],
  ["Cases", "\\begin{cases}#0 & \\\\ & \\end{cases}", "\\begin{cases}a&x<0\\\\b&x>0\\end{cases}"],
  [
    "Aligned equations",
    "\\begin{aligned}#0 & \\\\ & \\end{aligned}",
    "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
  ],
];

export const MATH_SYMBOLS: readonly MathSymbol[] = [
  ...structures.map(([label, latex, preview]): MathSymbol => ({
    id: `structures:${label}`,
    category: "structures",
    label,
    command: latex.replaceAll("#0", ""),
    latex,
    preview,
    packages: ["amsmath"],
    search: `${label} ${latex}`.toLowerCase(),
    action:
      label === "Superscript"
        ? "moveToSuperscript"
        : label === "Subscript"
          ? "moveToSubscript"
          : undefined,
  })),
  ...catalog.map(fromCatalog),
];

const packagesByCommand = new Map<string, Set<string>>();
for (const symbol of MATH_SYMBOLS) {
  const command = /^\\([A-Za-z]+)/u.exec(symbol.latex)?.[1];
  if (!command) continue;
  const packages = packagesByCommand.get(command) ?? new Set<string>();
  symbol.packages.forEach((name) => packages.add(name));
  packagesByCommand.set(command, packages);
}

/** Dependencies for newly introduced math commands, without touching existing declarations. */
export function newMathSymbolPackages(previous: string, next: string): string[] {
  const before = new Set([...previous.matchAll(/\\([A-Za-z]+)/gu)].map((match) => match[1]));
  const packages = new Set<string>();
  for (const match of next.matchAll(/\\([A-Za-z]+)/gu)) {
    if (!before.has(match[1]))
      packagesByCommand.get(match[1]!)?.forEach((name) => packages.add(name));
  }
  return [...packages];
}
