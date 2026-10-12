export const MATH_BRACKETS = [
  { value: "round", left: "(", right: ")", leftLatex: "(", rightLatex: ")" },
  { value: "square", left: "[", right: "]", leftLatex: "[", rightLatex: "]" },
  { value: "brace", left: "{", right: "}", leftLatex: "\\lbrace", rightLatex: "\\rbrace" },
  { value: "angle", left: "⟨", right: "⟩", leftLatex: "\\langle", rightLatex: "\\rangle" },
  { value: "bar", left: "|", right: "|", leftLatex: "\\vert", rightLatex: "\\vert" },
  { value: "double-bar", left: "‖", right: "‖", leftLatex: "\\Vert", rightLatex: "\\Vert" },
  { value: "floor", left: "⌊", right: "⌋", leftLatex: "\\lfloor", rightLatex: "\\rfloor" },
  { value: "ceiling", left: "⌈", right: "⌉", leftLatex: "\\lceil", rightLatex: "\\rceil" },
  { value: "none", left: "None", right: "None", leftLatex: ".", rightLatex: "." },
] as const;

export type MathBracket = (typeof MATH_BRACKETS)[number]["value"];
export const MATH_BRACKET_SIZES = ["auto", "normal", "big", "Big", "bigg", "Bigg"] as const;
export type MathBracketSize = (typeof MATH_BRACKET_SIZES)[number];

/** A selection template for MathLive; invisible fixed-size sides emit no delimiter. */
export function mathBracketsTemplate(left: MathBracket, right: MathBracket, size: MathBracketSize) {
  const opening = MATH_BRACKETS.find((bracket) => bracket.value === left);
  const closing = MATH_BRACKETS.find((bracket) => bracket.value === right);
  if (!opening || !closing || (left === "none" && right === "none")) return null;
  if (size === "auto") return `\\left${opening.leftLatex} #0 \\right${closing.rightLatex}`;
  const side = (value: string, direction: "l" | "r") => {
    if (value === ".") return "";
    if (size === "normal")
      return ["\\vert", "\\Vert"].includes(value)
        ? `\\math${direction === "l" ? "open" : "close"}{${value}}`
        : value;
    return `\\${size}${direction}${value}`;
  };
  return `${side(opening.leftLatex, "l")} #0 ${side(closing.rightLatex, "r")}`;
}
