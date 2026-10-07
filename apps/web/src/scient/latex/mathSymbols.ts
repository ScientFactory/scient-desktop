import catalog from "./mathSymbolCatalog.json";
import { latexCommands, latexWithoutComments } from "./latexPackages";

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

/** Catalog aliases keep their IDs; the picker shows the LaTeX it actually inserts. */
export function mathSymbolCommand(symbol: MathSymbol): string {
  const insertedCommand = /^\\[A-Za-z]+/u.exec(symbol.latex)?.[0];
  return /^\\[A-Za-z]+$/u.test(symbol.command) && insertedCommand !== symbol.command
    ? symbol.latex.replace(/#[0-9?]/gu, "")
    : symbol.command;
}

// Command membership and Unicode/package facts were checked against LyX's
// lib/ui/stdtoolbars.inc and lib/symbols (2026-09-24). The UI, insertion templates
// and search vocabulary here are Scient's. No LyX icons or implementation code.
export const MATH_SYMBOL_CATEGORIES = [
  ["structures", "Structures", "√"],
  ["annotations", "Braces & annotations", "⏟"],
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
  overbrace: "Overbrace with label",
  underbrace: "Underbrace with label",
  overset: "Annotation above",
  underset: "Annotation below",
  stackrel: "Relation with annotation above",
  stackrelthree: "Annotations above and below",
  xleftarrow: "Left arrow with labels",
  xrightarrow: "Right arrow with labels",
  xleftrightarrow: "Two-way arrow with labels",
  xLeftarrow: "Double left arrow with labels",
  xRightarrow: "Double right arrow with labels",
  xLeftrightarrow: "Double two-way arrow with labels",
  xhookleftarrow: "Hook left arrow with labels",
  xhookrightarrow: "Hook right arrow with labels",
  xmapsto: "Maps to arrow with labels",
  xleftrightharpoons: "Left right harpoons with labels",
  xrightleftharpoons: "Right left harpoons with labels",
  cancel: "Strike through",
  bcancel: "Reverse strike through",
  xcancel: "Cross out",
  cancelto: "Cancel to a value",
  widehat: "Wide hat accent",
  widetilde: "Wide tilde accent",
  tilde: "Tilde accent",
  liminf: "Limit inferior",
  limsup: "Limit superior",
  ln: "Natural logarithm",
  log: "Logarithm",
  sin: "Sine",
  cos: "Cosine",
  tan: "Tangent",
  exp: "Exponential",
  det: "Determinant operator",
  Pr: "Probability",
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
  dots: "Automatic dots ellipsis",
  operatorname: "Custom function operator name",
  pmod: "Parenthesized modulo congruence",
  mod: "Modulo",
  mathnormal: "Normal math alphabet",
  langle: "Left angle bracket",
  rangle: "Right angle bracket",
  lbrace: "Left brace",
  rbrace: "Right brace",
  lvert: "Left absolute value bar",
  rvert: "Right absolute value bar",
  lVert: "Left norm bar",
  rVert: "Right norm bar",
  backslash: "Backslash",
  quad: "Em space",
  qquad: "Double em space",
  enspace: "Half em space",
  " ": "Word space",
  ",": "Thin space",
  ":": "Medium space",
  ";": "Thick space",
  "!": "Negative thin space",
};

const labeledArrows = [
  "xleftarrow",
  "xrightarrow",
  "xleftrightarrow",
  "xLeftarrow",
  "xRightarrow",
  "xLeftrightarrow",
  "xhookleftarrow",
  "xhookrightarrow",
  "xmapsto",
  "xleftrightharpoons",
  "xrightleftharpoons",
] as const;

// #0 wraps the selected expression; an empty selection becomes an editable slot.
const templates: Record<string, string> = {
  frac: "\\frac{#0}{}",
  dfrac: "\\dfrac{#0}{}",
  tfrac: "\\tfrac{#0}{}",
  cfrac: "\\cfrac{#0}{}",
  cfracleft: "\\cfrac[l]{#0}{}",
  cfracright: "\\cfrac[r]{#0}{}",
  sqrt: "\\sqrt{#0}",
  root: "\\sqrt[#?]{#0}",
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
  overbrace: "\\overbrace{#0}^{#?}",
  underbrace: "\\underbrace{#0}_{#?}",
  overset: "\\overset{#?}{#0}",
  underset: "\\underset{#?}{#0}",
  stackrel: "\\stackrel{#?}{#0}",
  stackrelthree: "\\overset{#?}{\\underset{#?}{#0}}",
  cancelto: "\\cancelto{#?}{#0}",
  cancel: "\\cancel{#0}",
  bcancel: "\\bcancel{#0}",
  xcancel: "\\xcancel{#0}",
  sideset: "\\sideset{_{}^{}}{_{}^{}}{#0}",
  sidesetl: "\\sideset{_{}^{}}{}{#0}",
  sidesetr: "\\sideset{}{_{}^{}}{#0}",
  sidesetn: "\\sideset{}{}{#0}",
  ...Object.fromEntries(labeledArrows.map((name) => [name, `\\${name}[#?]{#0}`])),
  operatorname: "\\operatorname{#0}",
  pmod: "\\pmod{#0}",
  mod: "\\mod{#0}",
  mathnormal: "\\mathnormal{#0}",
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
  xleftarrow: ["amsmath"],
  xrightarrow: ["amsmath"],
  xleftrightarrow: ["mathtools"],
  operatorname: ["amsmath"],
  pmod: ["amsmath"],
  mod: ["amsmath"],
  dots: ["amsmath"],
  mathnormal: [],
};

const previewsByCommand: Record<string, string> = {
  root: "\\sqrt[n]{x}",
  underbrace: "\\underbrace{x}_{a}",
  overbrace: "\\overbrace{x}^{a}",
  overset: "\\overset{a}{x}",
  underset: "\\underset{a}{x}",
  stackrel: "\\stackrel{a}{=}",
  stackrelthree: "\\overset{a}{\\underset{b}{x}}",
  ...Object.fromEntries(labeledArrows.map((name) => [name, `\\${name}{a}`])),
  operatorname: "\\operatorname{f}",
  pmod: "\\pmod{n}",
  mod: "\\mod{n}",
  textdegree: "{}^{\\circ}",
};
const namedSymbols: Record<string, string> = {
  "+": "Addition plus",
  "-": "Subtraction minus",
  "/": "Division slash",
  "!": "Factorial",
  "=": "Equal",
  "<": "Less than",
  ">": "Greater than",
  "\\mathbb N": "Natural numbers",
  "\\mathbb Z": "Integers",
  "\\mathbb Q": "Rational numbers",
  "\\mathbb R": "Real numbers",
  "\\mathbb C": "Complex numbers",
  "\\mathbb H": "Quaternions",
  "\\mathcal O": "Big O",
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
  const label =
    namedSymbols[row.command] ??
    (simple
      ? (names[name] ??
        (row.category === "latex_greek"
          ? `${/^[A-Z]/u.test(name) ? "Capital " : ""}${name.replace(/^var/u, "")} ${name.startsWith("var") ? "variant" : ""}`.trim()
          : name))
      : row.command.replaceAll("\\", ""));
  const categoryLabel = MATH_SYMBOL_CATEGORIES.find(([id]) => id === row.category)?.[1] ?? "";
  return {
    id: `${row.category}:${row.command}`,
    category:
      labeledArrows.some((arrow) => arrow === name) ||
      /^(?:overbrace|underbrace|overset|underset|stackrel|stackrelthree|cancel|bcancel|xcancel|cancelto)$/u.test(
        name,
      )
        ? "annotations"
        : row.category,
    command: row.command,
    label,
    latex,
    preview:
      previewsByCommand[name] ??
      latex
        .replaceAll("#0", row.category === "font" ? "A" : "x")
        .replaceAll("#?", "a")
        .replaceAll("{}", "{a}"),
    ...(row.glyph === undefined ? {} : { glyph: row.glyph }),
    packages,
    search: `${label} ${row.command} ${row.glyph ?? ""} ${categoryLabel}`.toLowerCase(),
  };
}

const structures: [string, string, string, string[]?][] = [
  ["Text in math", "\\text{#0}", "\\text{x}"],
  ["Boxed expression", "\\boxed{#0}", "\\boxed{x}"],
  ["Evaluate at", "\\left.#0\\right|_{#?}^{#?}", "\\left.x\\right|_a^b"],
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
  [
    "Double brackets",
    "\\left\\llbracket#0\\right\\rrbracket",
    "\\llbracket x\\rrbracket",
    ["stmaryrd"],
  ],
  ["Bra", "\\left\\langle#0\\right|", "\\langle x|"],
  ["Ket", "\\left|#0\\right\\rangle", "|x\\rangle"],
  ["Inner product", "\\left\\langle#0\\middle|#?\\right\\rangle", "\\langle x|y\\rangle"],
  ["Set builder", "\\left\\{#0\\middle|#?\\right\\}", "\\{x|y\\}"],
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
  [
    "Brace matrix",
    "\\begin{Bmatrix}#0 & \\\\ & \\end{Bmatrix}",
    "\\begin{Bmatrix}a&b\\\\c&d\\end{Bmatrix}",
  ],
  [
    "Double bar matrix",
    "\\begin{Vmatrix}#0 & \\\\ & \\end{Vmatrix}",
    "\\begin{Vmatrix}a&b\\\\c&d\\end{Vmatrix}",
  ],
  [
    "Small matrix",
    "\\begin{smallmatrix}#0 & \\\\ & \\end{smallmatrix}",
    "\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}",
  ],
  ["Cases", "\\begin{cases}#0 & \\\\ & \\end{cases}", "\\begin{cases}x\\\\y\\end{cases}"],
  [
    "Aligned equations",
    "\\begin{aligned}#0 & \\\\ & \\end{aligned}",
    "\\begin{aligned}&x\\\\&y\\end{aligned}",
  ],
];

// Selected gaps from LyX, LibreOffice Math and MathLive; retain standard TeX
// spellings rather than copying editor-specific aliases or compound examples.
const additions = [
  ...["+", "-", "/", "!"].map((command) => fromCatalog({ category: "latex_bop", command })),
  ...["=", "<", ">"].map((command) => fromCatalog({ category: "latex_brel", command })),
  ...["langle", "rangle", "lbrace", "rbrace", "lvert", "rvert", "lVert", "rVert", "backslash"].map(
    (name) => fromCatalog({ category: "latex_delim", command: `\\${name}`, packages: [] }),
  ),
  fromCatalog({ category: "latex_dots", command: "\\dots" }),
  fromCatalog({ category: "font", command: "\\mathnormal" }),
  ...["\\enspace", "\\ "].map((command) =>
    fromCatalog({ category: "space", command, packages: [] }),
  ),
  ...["operatorname", "pmod", "mod"].map((name) =>
    fromCatalog({ category: "functions", command: `\\${name}` }),
  ),
  ...labeledArrows
    .filter((name) => !catalog.some((symbol) => symbol.command === `\\${name}`))
    .map((name) =>
      fromCatalog({ category: "latex_deco", command: `\\${name}`, packages: ["mathtools"] }),
    ),
  ...[
    ["arccot", "Inverse cotangent"],
    ["arsinh", "Inverse hyperbolic sine arcsinh"],
    ["arcosh", "Inverse hyperbolic cosine arccosh"],
    ["artanh", "Inverse hyperbolic tangent arctanh"],
    ["arcoth", "Inverse hyperbolic cotangent arccoth"],
    ["sgn", "Sign signum"],
    ["lcm", "Least common multiple"],
    ["rank", "Matrix rank"],
    ["tr", "Matrix trace"],
  ].map(([name, label]): MathSymbol => ({
    id: `functions:operatorname:${name}`,
    category: "functions",
    label: label!,
    command: `\\operatorname{${name}}`,
    latex: `\\operatorname{${name}}`,
    preview: `\\operatorname{${name}}`,
    packages: ["amsmath"],
    search: `${name} ${label} function operator`.toLowerCase(),
  })),
];

export const MATH_SYMBOLS: readonly MathSymbol[] = [
  ...structures.map(([label, latex, preview, packages]): MathSymbol => ({
    id: `structures:${label}`,
    category: "structures",
    label,
    command: latex.replace(/#[0-9?]/gu, ""),
    latex,
    preview,
    packages: packages ?? ["amsmath"],
    search: `${label} ${latex}`.toLowerCase(),
    ...(label === "Superscript"
      ? { action: "moveToSuperscript" as const }
      : label === "Subscript"
        ? { action: "moveToSubscript" as const }
        : {}),
  })),
  ...catalog.map(fromCatalog),
  ...additions,
];

const packagesByCommand = new Map<string, Set<string>>();
for (const symbol of MATH_SYMBOLS) {
  const command = /^\\([A-Za-z]+)/u.exec(symbol.latex)?.[1];
  if (!command || command === "begin" || command === "left" || command === "right") continue;
  const packages = packagesByCommand.get(command) ?? new Set<string>();
  symbol.packages.forEach((name) => packages.add(name));
  packagesByCommand.set(command, packages);
}

/** Dependencies for newly introduced math commands, without touching existing declarations. */
export function newMathSymbolPackages(previous: string, next: string): string[] {
  const before = new Set(latexCommands(previous).map((match) => match[1]));
  const packages = new Set<string>();
  for (const match of latexCommands(next)) {
    if (!before.has(match[1]))
      packagesByCommand.get(match[1]!)?.forEach((name) => packages.add(name));
  }
  const environments = (source: string) => {
    const clean = latexWithoutComments(source);
    return new Set(
      latexCommands(source).flatMap((command) => {
        if (command[1] !== "begin") return [];
        const name = /^\s*\{([^{}]+)\}/u.exec(clean.slice(command.index + command[0].length))?.[1];
        return name ? [name] : [];
      }),
    );
  };
  const oldEnvironments = environments(previous);
  for (const environment of environments(next)) {
    if (oldEnvironments.has(environment)) continue;
    if (
      /^(?:align|alignat|flalign|gather|multline|equation)\*?$|^(?:aligned|alignedat|gathered|split|[pbBvV]?matrix|smallmatrix|cases)$/u.test(
        environment,
      )
    )
      packages.add("amsmath");
    if (/^(?:[drl]+cases\*?|cases\*|[pbBvV]?matrix\*)$/u.test(environment))
      packages.add("mathtools");
  }
  return [...packages];
}
