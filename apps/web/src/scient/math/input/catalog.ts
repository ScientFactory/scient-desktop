import { decodeMsg, msg } from "gt-react";

/** Commands are editor independent. Templates use | for an empty caret slot,
 * and @ for the current selection. Neither marker is written to the document. */
export interface MathCommand {
  readonly id: string;
  readonly label: string;
  readonly group: keyof typeof MATH_GROUP_LABELS;
  readonly template: string;
  readonly completion?: string;
  readonly lyx?: readonly string[];
  readonly requires?: "amsmath" | "amssymb";
}

export const MATH_GROUP_LABELS = {
  Greek: msg("Greek", { $context: "math palette group" }),
  Operators: msg("Operators", { $context: "math palette group" }),
  Relations: msg("Relations", { $context: "math palette group" }),
  Arrows: msg("Arrows", { $context: "math palette group" }),
  Structures: msg("Structures", { $context: "math palette group" }),
  Accents: msg("Accents", { $context: "math palette group" }),
  Delimiters: msg("Delimiters", { $context: "math palette group" }),
  Matrices: msg("Matrices", { $context: "math palette group" }),
};

const greek: readonly [string, string, string][] = [
  ["alpha", "α", "a"],
  ["beta", "β", "b"],
  ["gamma", "γ", "g"],
  ["delta", "δ", "d"],
  ["epsilon", "ε", "e"],
  ["varepsilon", "ϵ", "shift+e"],
  ["zeta", "ζ", "z"],
  ["eta", "η", "h"],
  ["theta", "θ", "v"],
  ["vartheta", "ϑ", "q"],
  ["iota", "ι", "i"],
  ["kappa", "κ", "k"],
  ["lambda", "λ", "l"],
  ["mu", "μ", "m"],
  ["nu", "ν", "n"],
  ["xi", "ξ", "x"],
  ["pi", "π", "p"],
  ["varpi", "ϖ", ""],
  ["rho", "ρ", "r"],
  ["varrho", "ϱ", "shift+r"],
  ["sigma", "σ", "s"],
  ["varsigma", "ς", "shift+t"],
  ["tau", "τ", "t"],
  ["upsilon", "υ", "u"],
  ["phi", "φ", "f"],
  ["varphi", "ϕ", "j"],
  ["chi", "χ", "c"],
  ["psi", "ψ", "y"],
  ["omega", "ω", "w"],
  ["Gamma", "Γ", "shift+g"],
  ["Delta", "Δ", "shift+d"],
  ["Theta", "Θ", "shift+v"],
  ["Lambda", "Λ", "shift+l"],
  ["Xi", "Ξ", "shift+x"],
  ["Pi", "Π", "shift+p"],
  ["Sigma", "Σ", "shift+s"],
  ["Upsilon", "Υ", "shift+u"],
  ["Phi", "Φ", "shift+f"],
  ["Psi", "Ψ", "shift+y"],
  ["Omega", "Ω", "shift+w"],
];

const symbols = (group: MathCommand["group"], entries: string): MathCommand[] =>
  entries.split(" ").map((name) => ({
    id: `math.symbol.${name}`,
    label: name,
    group,
    template: `\\${name} `,
    completion: name,
    ...(["iint", "iiint"].includes(name) ? { requires: "amsmath" as const } : {}),
  }));

const structure = (
  id: string,
  label: string,
  template: string,
  lyx: string,
  group: MathCommand["group"] = "Structures",
  completion = id,
): MathCommand => ({
  id: `math.${id}`,
  label,
  group,
  template,
  completion,
  ...(lyx ? { lyx: [lyx] } : {}),
  ...(["text", "norm", "binomial", "pmatrix", "bmatrix", "vmatrix", "cases", "aligned"].includes(id)
    ? { requires: "amsmath" as const }
    : {}),
});

export const MATH_COMMANDS: readonly MathCommand[] = [
  ...greek.map(([name, glyph, key]): MathCommand => ({
    id: `math.symbol.${name}`,
    label: `${glyph} ${name}`,
    group: "Greek",
    template: `\\${name} `,
    completion: name,
    ...(key
      ? {
          lyx: [
            `g ${key}`,
            ...(name === "omega" ? ["g o"] : name === "Omega" ? ["g shift+o"] : []),
            ...(name === "iota"
              ? ["g shift+i"]
              : name === "epsilon"
                ? ["g shift+j"]
                : name === "vartheta"
                  ? ["g shift+q"]
                  : []),
          ],
        }
      : {}),
  })),
  ...symbols(
    "Operators",
    "sum prod coprod int oint iint iiint infty partial nabla times cdot div pm mp circ bullet ast star cap cup bigcap bigcup bigoplus bigotimes sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp lim min max sup inf det gcd ker dim",
  ),
  ...symbols(
    "Relations",
    "leq geq neq approx equiv sim simeq cong propto in notin ni subset supset subseteq supseteq ll gg parallel perp mid models prec succ preceq succeq forall exists neg emptyset",
  ),
  ...symbols(
    "Arrows",
    "to leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow longrightarrow longleftarrow longleftrightarrow Longrightarrow Longleftarrow Longleftrightarrow mapsto hookrightarrow hookleftarrow uparrow downarrow updownarrow",
  ),
  structure("sumLimits", msg("Sum with limits"), "\\sum_{|}^{@}", "l u"),
  structure("productLimits", msg("Product with limits"), "\\prod_{|}^{@}", "l p"),
  structure("integralLimits", msg("Integral with limits"), "\\int_{|}^{@}", "l i"),
  structure("limit", msg("Limit"), "\\lim_{|} @", "l l"),
  structure("binomial", msg("Binomial coefficient"), "\\binom{@}{|}", "t b"),
  structure(
    "pmatrix",
    msg("Parentheses matrix (2 by 2)"),
    "\\begin{pmatrix}| & \\\\ & \\end{pmatrix}",
    "t p",
    "Matrices",
  ),
  structure(
    "bmatrix",
    msg("Bracket matrix (2 by 2)"),
    "\\begin{bmatrix}| & \\\\ & \\end{bmatrix}",
    "t m",
    "Matrices",
  ),
  structure(
    "vmatrix",
    msg("Determinant (2 by 2)"),
    "\\begin{vmatrix}| & \\\\ & \\end{vmatrix}",
    "t d",
    "Matrices",
  ),
  structure("cases", msg("Cases"), "\\begin{cases}| & \\\\ & \\end{cases}", "t c", "Matrices"),
  structure(
    "aligned",
    msg("Aligned calculation"),
    "\\begin{aligned}| & \\\\ & \\end{aligned}",
    "t a",
    "Matrices",
  ),
  structure("fraction", msg("Fraction"), "\\frac{@}{|}", "f", "Structures", "frac"),
  structure("sqrt", msg("Square root"), "\\sqrt{@}", "s"),
  structure("root", msg("Nth root"), "\\sqrt[|]{@}", "r"),
  structure("subscript", msg("Subscript"), "_{@}", "x"),
  structure("superscript", msg("Superscript"), "^{@}", "e"),
  structure("text", msg("Text in math"), "\\text{@}", "", "Structures"),
  {
    ...structure("boxed", msg("Boxed expression"), "\\boxed{@}", "", "Structures"),
    requires: "amsmath",
  },
  ...(
    [
      "hat:h",
      "vec:v",
      "bar:-",
      "overline:b",
      "underline:_",
      "dot:.",
      'ddot:"',
      "acute:/",
      "grave:\\",
      "tilde:&",
      "check:shift+v",
      "breve:shift+u",
      "widehat:",
      "widetilde:",
    ] as const
  ).map((entry) => {
    const [name = "", key = ""] = entry.split(":");
    return structure(name, name, `\\${name}{@}`, key, "Accents");
  }),
  structure("overbrace", msg("Overbrace with label"), "\\overbrace{@}^{|}", "", "Accents"),
  structure("underbrace", msg("Underbrace with label"), "\\underbrace{@}_{|}", "", "Accents"),
  {
    ...structure("overset", msg("Annotation above"), "\\overset{|}{@}", "", "Accents"),
    requires: "amsmath",
  },
  {
    ...structure("underset", msg("Annotation below"), "\\underset{|}{@}", "", "Accents"),
    requires: "amsmath",
  },
  {
    ...structure("xleftarrow", msg("Left arrow with labels"), "\\xleftarrow[|]{@}", "", "Arrows"),
    requires: "amsmath",
  },
  {
    ...structure(
      "xrightarrow",
      msg("Right arrow with labels"),
      "\\xrightarrow[|]{@}",
      "",
      "Arrows",
    ),
    requires: "amsmath",
  },
  structure("parentheses", msg("Parentheses"), "\\left(@\\right)", "(", "Delimiters"),
  structure("brackets", msg("Square brackets"), "\\left[@\\right]", "[", "Delimiters"),
  structure("braces", msg("Braces"), "\\left\\{@\\right\\}", "{", "Delimiters"),
  structure("angles", msg("Angle brackets"), "\\left\\langle @\\right\\rangle", "<", "Delimiters"),
  structure(
    "reverseAngles",
    msg("Reversed angle brackets"),
    "\\left\\rangle @\\right\\langle",
    ">",
    "Delimiters",
  ),
  structure("norm", msg("Norm"), "\\left\\lVert @\\right\\rVert", "", "Delimiters"),
  structure("absolute", msg("Absolute value"), "\\left\\vert @\\right\\vert", "|", "Delimiters"),
  structure("space", msg("Math space"), "\\;", "space"),
  structure("prime", msg("Prime"), "\\prime ", "'", "Accents"),
  structure("limits", msg("Limits above and below"), "\\limits", "shift+l l"),
  structure("nolimits", msg("Limits alongside"), "\\nolimits", "shift+l n"),
];

const byId = new Map(MATH_COMMANDS.map((command) => [command.id, command]));
export function mathCommand(id: string): MathCommand | undefined {
  return byId.get(id);
}

export interface MathSelection {
  readonly from: number;
  readonly to: number;
}
export interface MathEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly selection: MathSelection;
}

export function commandEdit(
  command: MathCommand,
  source: string,
  selection: MathSelection,
): MathEdit {
  const selected = source.slice(selection.from, selection.to);
  let insert = "";
  let caret: number | undefined;
  for (const character of command.template) {
    if (character === "|") {
      caret ??= insert.length;
      continue;
    }
    if (character === "@") {
      if (!selected) caret ??= insert.length;
      insert += selected;
    } else insert += character;
  }
  const offset = selection.from + (caret ?? insert.length);
  return { ...selection, insert, selection: { from: offset, to: offset } };
}

export function matchingMathCommands(
  query: string,
  translate?: (label: string) => string,
): readonly MathCommand[] {
  const needle = query.replace(/^\\/u, "").toLowerCase();
  return MATH_COMMANDS.filter(
    ({ label, completion }) =>
      `${decodeMsg(label)} ${completion ?? ""}`.toLowerCase().includes(needle) ||
      (translate?.(label).toLowerCase().includes(needle) ?? false),
  );
}
