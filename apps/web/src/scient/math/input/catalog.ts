/** Commands are editor independent. Templates use | for an empty caret slot,
 * and @ for the current selection. Neither marker is written to the document. */
export interface MathCommand {
  readonly id: string;
  readonly label: string;
  readonly group:
    | "Greek"
    | "Operators"
    | "Relations"
    | "Arrows"
    | "Structures"
    | "Accents"
    | "Delimiters"
    | "Matrices";
  readonly template: string;
  readonly completion?: string;
  readonly lyx?: readonly string[];
  readonly requires?: "amsmath" | "amssymb";
}

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
  ...(["text", "norm"].includes(id) ? { requires: "amsmath" as const } : {}),
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
  structure("fraction", "Fraction", "\\frac{@}{|}", "f", "Structures", "frac"),
  structure("sqrt", "Square root", "\\sqrt{@}", "s"),
  structure("root", "Nth root", "\\sqrt[|]{@}", "r"),
  structure("subscript", "Subscript", "_{@}", "x"),
  structure("superscript", "Superscript", "^{@}", "e"),
  structure("text", "Text in math", "\\text{@}", "", "Structures"),
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
      "overbrace:",
      "underbrace:",
    ] as const
  ).map((entry) => {
    const [name = "", key = ""] = entry.split(":");
    return structure(name, name, `\\${name}{@}`, key, "Accents");
  }),
  structure("parentheses", "Parentheses", "\\left(@\\right)", "(", "Delimiters"),
  structure("brackets", "Square brackets", "\\left[@\\right]", "[", "Delimiters"),
  structure("braces", "Braces", "\\left\\{@\\right\\}", "{", "Delimiters"),
  structure("angles", "Angle brackets", "\\left\\langle @\\right\\rangle", "<", "Delimiters"),
  structure(
    "reverseAngles",
    "Reversed angle brackets",
    "\\left\\rangle @\\right\\langle",
    ">",
    "Delimiters",
  ),
  structure("norm", "Norm", "\\left\\lVert @\\right\\rVert", "", "Delimiters"),
  structure("absolute", "Absolute value", "\\left\\vert @\\right\\vert", "|", "Delimiters"),
  structure("space", "Math space", "\\;", "space"),
  structure("prime", "Prime", "\\prime ", "'", "Accents"),
  structure("limits", "Limits above and below", "\\limits", "shift+l l"),
  structure("nolimits", "Limits alongside", "\\nolimits", "shift+l n"),
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

export function matchingMathCommands(query: string): readonly MathCommand[] {
  const needle = query.replace(/^\\/u, "").toLowerCase();
  return MATH_COMMANDS.filter((command) =>
    `${command.label} ${command.completion ?? ""}`.toLowerCase().includes(needle),
  );
}
