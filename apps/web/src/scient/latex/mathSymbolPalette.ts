import { mathSymbolCommand, type MathSymbol } from "./mathSymbols";

/** Presentation groups share the catalog used for insertion and package discovery. */
export const MATH_PALETTE_GROUPS = [
  { id: "common", label: "Common", categories: [] },
  {
    id: "structures",
    label: "Structures",
    categories: ["structures", "frac-square", "sqrt-square"],
  },
  { id: "annotations", label: "Labels", categories: ["annotations"] },
  { id: "greek", label: "Greek", categories: ["latex_greek"] },
  { id: "operators", label: "Operators", categories: ["latex_bop", "latex_ams_ops"] },
  { id: "sets", label: "Sets", categories: [] },
  {
    id: "relations",
    label: "Relations",
    categories: ["latex_brel", "latex_ams_rel", "latex_ams_nrel"],
  },
  { id: "arrows", label: "Arrows", categories: ["latex_arrow", "latex_ams_arrows"] },
  { id: "large", label: "Calculus", categories: ["latex_varsz"] },
  { id: "accents", label: "Accents", categories: ["latex_deco"] },
  { id: "brackets", label: "Brackets", categories: ["latex_delim"] },
  { id: "functions", label: "Functions", categories: ["functions"] },
  { id: "alphabets", label: "Alphabets", categories: ["font"] },
  { id: "spacing", label: "Spacing", categories: ["space"] },
  {
    id: "other",
    label: "More",
    categories: ["latex_dots", "style", "latex_misc", "latex_ams_misc"],
  },
] as const;

const common = [
  "+",
  "-",
  "=",
  "<",
  ">",
  "\\frac",
  "\\sqrt",
  "\\root",
  "\\underbrace",
  "\\overbrace",
  "\\overset",
  "\\underset",
  "\\xrightarrow",
  "structures:Text in math",
  "structures:Boxed expression",
  "structures:Norm",
  "structures:Absolute value",
  "structures:Evaluate at",
  "\\sum",
  "\\prod",
  "\\int",
  "\\lim",
  "\\alpha",
  "\\beta",
  "\\theta",
  "\\lambda",
  "\\pi",
  "\\infty",
  "\\partial",
  "\\nabla",
  "\\pm",
  "\\times",
  "\\cdot",
  "\\leq",
  "\\geq",
  "\\neq",
  "\\approx",
  "\\in",
  "\\subseteq",
  "\\cup",
  "\\cap",
  "\\emptyset",
  "\\forall",
  "\\exists",
  "\\rightarrow",
  "\\Rightarrow",
  "\\mathbb R",
  "\\mathbb N",
];
const fences = new Set(
  [
    "Parentheses",
    "Brackets",
    "Braces",
    "Absolute value",
    "Norm",
    "Angle brackets",
    "Floor",
    "Ceiling",
    "Double brackets",
    "Bra",
    "Ket",
    "Inner product",
  ].map((label) => `structures:${label}`),
);
const setCommands = new Set(
  [
    "Subset",
    "Supset",
    "sqsubset",
    "sqsupset",
    "sqsubseteq",
    "sqsupseteq",
    "emptyset",
    "varnothing",
    "in",
    "notin",
    "ni",
    "inplus",
    "niplus",
    "subsetplus",
    "supsetplus",
    "subsetpluseq",
    "supsetpluseq",
    "backepsilon",
    "cap",
    "cup",
    "Cap",
    "Cup",
    "sqcap",
    "sqcup",
    "uplus",
    "setminus",
    "smallsetminus",
    "complement",
    "aleph",
    "beth",
    "gimel",
    "daleth",
  ].map((name) => `\\${name}`),
);
const logicCommands = /^\\(?:forall|exists|nexists|neg|lnot|land|lor|top|bot|implies|impliedby)$/u;

/** Presentation membership is independent of imported catalog IDs and saved favorites. */
function paletteCategory(symbol: MathSymbol): string | undefined {
  if (fences.has(symbol.id)) return "brackets";
  if (
    symbol.id === "structures:Set builder" ||
    setCommands.has(symbol.command) ||
    /^\\(?:var)?n?(?:sub|sup)set(?:eq|eqq|neq|neqq)?$/u.test(symbol.command) ||
    /^\\mathbb [NZQRCH]$/u.test(symbol.command)
  )
    return "sets";
  if (logicCommands.test(symbol.command)) return "relations";
  if (/^\\(?:partial|nabla|infty)$/u.test(symbol.command)) return "large";
  if (/^\\(?:digamma|varkappa)$/u.test(symbol.command)) return "greek";
  return MATH_PALETTE_GROUPS.find((group) =>
    group.categories.some((category) => category === symbol.category),
  )?.id;
}

// Lead with everyday choices; retain the extended catalog after them.
const preferred: Record<string, readonly string[]> = {
  operators: [
    "+",
    "-",
    "\\pm",
    "\\mp",
    "\\times",
    "\\cdot",
    "\\div",
    "/",
    "!",
    "\\circ",
    "\\oplus",
    "\\otimes",
  ],
  relations: [
    "=",
    "<",
    ">",
    "\\leq",
    "\\geq",
    "\\neq",
    "\\approx",
    "\\equiv",
    "\\sim",
    "\\propto",
    "\\coloneqq",
    "\\perp",
    "\\parallel",
    "\\forall",
    "\\exists",
    "\\nexists",
    "\\neg",
    "\\land",
    "\\lor",
    "\\implies",
    "\\iff",
  ],
  sets: [
    "\\in",
    "\\notin",
    "\\ni",
    "\\subset",
    "\\subseteq",
    "\\supset",
    "\\supseteq",
    "\\cup",
    "\\cap",
    "\\setminus",
    "\\emptyset",
    "\\varnothing",
    "\\mathbb N",
    "\\mathbb Z",
    "\\mathbb Q",
    "\\mathbb R",
    "\\mathbb C",
    "structures:Set builder",
  ],
  large: [
    "\\sum",
    "\\prod",
    "\\coprod",
    "\\int",
    "\\iint",
    "\\iiint",
    "\\oint",
    "\\partial",
    "\\nabla",
    "\\infty",
    "\\bigcup",
    "\\bigcap",
  ],
  brackets: [...fences],
  other: [
    "\\dots",
    "\\ldots",
    "\\cdots",
    "\\vdots",
    "\\ddots",
    "\\prime",
    "\\ell",
    "\\hbar",
    "\\Re",
    "\\Im",
  ],
};
const aliases: Record<string, string> = {
  underbrace: "under brace below label annotation terms",
  overbrace: "over brace above label annotation terms",
  overset: "above top annotation label",
  underset: "below bottom annotation label",
  xleftarrow: "left arrow above below label",
  xrightarrow: "right arrow above below label",
  xleftrightarrow: "both directions arrow above below label",
  sqrt: "square root radical",
  root: "nth n th indexed root radical",
  frac: "fraction numerator denominator divide division",
  binom: "binomial choose combination",
  mathcal: "calligraphic cursive",
  mathfrak: "fraktur gothic",
  mathscr: "script cursive",
  approx: "almost approximately equal",
  cdot: "multiply multiplication dot product",
  times: "multiply multiplication cross product",
  to: "right arrow",
  rightarrow: "to maps arrow",
  leftarrow: "gets assignment arrow",
  leq: "less than equal lte le <=",
  geq: "greater than equal gte ge >=",
  neq: "not equals unequal ne !=",
  langle: "angle bracket left",
  rangle: "angle bracket right",
  pmod: "mod modulo modular congruence parentheses",
  operatorname: "custom function upright operator name",
  land: "and conjunction logical boolean",
  lor: "or disjunction logical boolean",
  neg: "not negation logical boolean",
  mid: "divides divisible conditional such that",
  parallel: "parallel",
  coloneqq: "defined as definition equals colon assignment",
  mathnormal: "normal default italic font alphabet",
  mathbb: "blackboard double struck number sets natural integer rational real complex quaternion",
};
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\\{}#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
const searchFields = new WeakMap<MathSymbol, string>();

/** Hide script actions and identical insertions without changing catalog IDs or completions. */
export function mathPaletteSymbols(catalog: readonly MathSymbol[]): MathSymbol[] {
  const seen = new Set<string>();
  return catalog.filter((symbol) => {
    if (symbol.action || seen.has(symbol.latex)) return false;
    seen.add(symbol.latex);
    return true;
  });
}

export function mathPaletteGroup(catalog: readonly MathSymbol[], category: string): MathSymbol[] {
  if (category === "common")
    return common.flatMap((key) => {
      const symbol = catalog.find((entry) => entry.id === key || entry.command === key);
      return symbol ? [symbol] : [];
    });
  if (category === "document") return catalog.filter((symbol) => symbol.category === "document");
  const members = catalog.filter((symbol) => paletteCategory(symbol) === category);
  const first = (preferred[category] ?? []).flatMap((key) => {
    const symbol = members.find((entry) => entry.id === key || entry.command === key);
    return symbol ? [symbol] : [];
  });
  const ordered = new Set(first);
  return [...first, ...members.filter((symbol) => !ordered.has(symbol))];
}

/** Match names, commands, Unicode and everyday vocabulary; exact matches lead. */
export function searchMathPalette(catalog: readonly MathSymbol[], query: string): MathSymbol[] {
  const normalized = normalize(query);
  if (!normalized) return [...catalog];
  const terms = normalized.split(" ");
  return catalog
    .flatMap((symbol, index) => {
      let text = searchFields.get(symbol);
      if (text === undefined) {
        const name = /^\\([A-Za-z]+)/u.exec(symbol.command)?.[1] ?? "";
        text = normalize(
          `${symbol.label} ${symbol.command} ${mathSymbolCommand(symbol)} ${symbol.glyph ?? ""} ${symbol.search} ${aliases[name] ?? ""}`,
        );
        searchFields.set(symbol, text);
      }
      if (!terms.every((term) => text.includes(term))) return [];
      const command = normalize(mathSymbolCommand(symbol));
      const label = normalize(symbol.label);
      const rank =
        command === normalized || label === normalized || symbol.glyph === query.trim()
          ? 0
          : command.startsWith(normalized) || label.startsWith(normalized)
            ? 1
            : 2;
      return [{ symbol, rank, index }];
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ symbol }) => symbol);
}
