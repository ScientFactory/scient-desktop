import type { MathSymbol } from "./mathSymbols";

export type MathSymbolIllustration =
  | { kind: "spacing"; width: number; negative: boolean }
  | { kind: "phantom"; axis: "both" | "horizontal" | "vertical" }
  | { kind: "smash"; side: "both" | "top" | "bottom" }
  | { kind: "overlap"; align: "left" | "center" | "right" };

const spacingWidths: Record<string, number> = {
  ",": 6,
  ":": 9,
  ";": 12,
  quad: 23,
  qquad: 30,
  enspace: 17,
  " ": 8,
  "!": 6,
};

/** Invisible layout commands need diagrams, rather than a blank math rendering. */
export function mathSymbolIllustration(symbol: MathSymbol): MathSymbolIllustration | null {
  const name = /^\\([A-Za-z]+|.)/u.exec(symbol.command)?.[1] ?? "";
  if (name in spacingWidths)
    return { kind: "spacing", width: spacingWidths[name]!, negative: name === "!" };
  if (["phantom", "hphantom", "vphantom"].includes(name))
    return {
      kind: "phantom",
      axis: name === "hphantom" ? "horizontal" : name === "vphantom" ? "vertical" : "both",
    };
  if (["smash", "smasht", "smashb"].includes(name))
    return {
      kind: "smash",
      side: name === "smasht" ? "top" : name === "smashb" ? "bottom" : "both",
    };
  if (["mathllap", "mathclap", "mathrlap"].includes(name))
    return {
      kind: "overlap",
      align: name === "mathllap" ? "left" : name === "mathrlap" ? "right" : "center",
    };
  return null;
}

const visualPreviews: Record<string, string> = {
  frac: "\\textstyle\\frac{a}{b}",
  dfrac: "\\dfrac{a}{b}",
  tfrac: "\\tfrac{a}{b}",
  binom: "\\textstyle\\binom{a}{b}",
  dbinom: "\\dbinom{a}{b}",
  tbinom: "\\tbinom{a}{b}",
  cfrac: "\\cfrac{a}{\\frac{b}{c}}",
  cfracleft: "\\cfrac[l]{a}{bc}",
  cfracright: "\\cfrac[r]{a}{bc}",
  nicefrac: "{}^{a}\\! / \\!{}_{b}",
  unitone: "\\mathrm{m}",
  unittwo: "x\\,\\mathrm{m}",
  unitfrac: "\\frac{\\mathrm{m}}{\\mathrm{s}}",
  unitfracthree: "x\\,\\frac{\\mathrm{m}}{\\mathrm{s}}",
  boldsymbol: "\\boldsymbol{\\alpha}",
  textrm: "\\text{x}",
  utilde: "\\underset{\\sim}{x}",
  sideset: "{}_{a}\\!\\sum\\nolimits_{b}",
  sidesetl: "{}_{a}\\!\\sum",
  sidesetr: "\\sum\\nolimits_{a}",
  sidesetn: "\\sum",
  displaystyle: "x\\,{\\displaystyle\\frac{a}{b}}",
  textstyle: "x\\,{\\textstyle\\frac{a}{b}}",
  scriptstyle: "x\\,{\\scriptstyle\\frac{a}{b}}",
  scriptscriptstyle: "x\\,{\\scriptscriptstyle\\frac{a}{b}}",
  mathrel: "a\\mathrel{\\sim}b",
  mathbin: "a\\mathbin{\\star}b",
  mathop: "\\mathop{f}_{x}",
  mathord: "\\mathord{x}",
  widehat: "\\widehat{xy}",
  widetilde: "\\widetilde{xy}",
  overline: "\\overline{xy}",
  overleftarrow: "\\overleftarrow{xy}",
  overrightarrow: "\\overrightarrow{xy}",
  overleftrightarrow: "\\overleftrightarrow{xy}",
  underleftarrow: "\\underleftarrow{xy}",
  underrightarrow: "\\underrightarrow{xy}",
  underleftrightarrow: "\\underleftrightarrow{xy}",
  lvert: "\\lvert x",
  rvert: "x\\rvert",
  lVert: "\\lVert x",
  rVert: "x\\rVert",
  mid: "x\\mid y",
  parallel: "x\\parallel y",
  idotsint: "\\int\\cdots\\int",
  dots: "\\ldots",
};

/** Show only the notation needed to recognize a command. Samples never enter source. */
export function mathSymbolVisualPreview(symbol: MathSymbol): string {
  const name = /^\\([A-Za-z]+|.)/u.exec(symbol.command)?.[1] ?? "";
  if (symbol.category === "latex_varsz" && name.includes("int")) {
    const body = name === "idotsint" ? "\\int\\cdots\\int" : symbol.command;
    return `\\mathop{${body}}\\${name.endsWith("op") ? "limits" : "nolimits"}_{a}^{b}`;
  }
  if (symbol.category !== "document" && symbol.command === `\\${name}` && visualPreviews[name])
    return visualPreviews[name]!;
  if (symbol.command === "\\textrm \\AA") return "\\text{Ã…}";
  if (symbol.command === "\\textrm \\O") return "\\text{Ã˜}";
  if (symbol.id === "structures:Text in math") return "\\text{x}";
  if (symbol.category === "functions" && !/#[0-9?]/u.test(symbol.latex)) return symbol.command;
  return symbol.preview;
}
