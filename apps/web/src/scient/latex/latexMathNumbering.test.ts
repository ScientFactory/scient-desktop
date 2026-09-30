import { describe, expect, it } from "vite-plus/test";
import { patchNumberedMathSource, projectMathNumbering } from "./latexMathNumbering";
import {
  applyLatexVisualDocumentChange,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  projectLatexVisualDocument,
} from "./latexVisualDocument";

const equation = [
  "\\begin{align}",
  "  x &= \\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix} \\label{eq:matrix} \\\\[2pt]",
  "  y &= z \\tag*{A} \\nonumber",
  "\\end{align}",
].join("\n");
const source = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  equation,
  "\\end{document}",
].join("\n");

describe("numbered equation source preservation", () => {
  it("projects outer row math while keeping labels and tags out of the math field", () => {
    const parsed = parseLatexVisualMathSource(equation, true)!;
    expect(parsed.tex).toContain("\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}");
    expect(parsed.tex).not.toMatch(/\\(?:label|tag|nonumber)/u);
    expect(parsed.numbering).toEqual([["\\label{eq:matrix}"], ["\\tag*{A}", "\\nonumber"]]);
    expect(latexVisualMathSource(parsed, true)).toBe(equation);
  });

  it("patches edited math through the document save adapter without rewriting other rows or commands", () => {
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks[0]?.node.type).toBe("latexDisplayMath");
    expect(projection.blocks[0]?.editable).toBe(true);
    const content = structuredClone(projection.content);
    content.content![0]!.attrs!.tex = String(content.content![0]!.attrs!.tex).replace(
      "x &=",
      "u &=",
    );
    const changed = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(changed.source).toBe(source.replace("x &=", "u &="));
    const again = structuredClone(changed.projection.content);
    again.content![0]!.attrs!.tex = String(again.content![0]!.attrs!.tex).replace("y &=", "v &=");
    expect(applyLatexVisualDocumentChange(changed.source, changed.projection, again)?.source).toBe(
      source.replace("x &=", "u &=").replace("y &=", "v &="),
    );
  });

  it("preserves commands before the formula and braces inside a tag", () => {
    const original = "\\begin{equation}\n\\label{eq:start} x + y \\tag{\\text{A}}\n\\end{equation}";
    expect(patchNumberedMathSource(original, "x + z")).toBe(original.replace("x + y", "x + z"));
  });

  it("preserves notag and original spacing for unchanged rows", () => {
    const original =
      "\\begin{gather}\r\n  x = y \\notag \\\\\r\n  a = b \\label {eq:second}\r\n\\end{gather}";
    expect(patchNumberedMathSource(original, "x = z \\\\\na = b")).toBe(
      original.replace("x = y", "x = z"),
    );
  });

  it("refuses row additions, command injection and equation type conversion", () => {
    const projection = projectLatexVisualDocument(source);
    const content = structuredClone(projection.content);
    const attributes = content.content![0]!.attrs!;
    attributes.tex += " \\\\ q = r";
    expect(applyLatexVisualDocumentChange(source, projection, content)).toBeNull();
    attributes.tex = "q \\label{new}";
    expect(applyLatexVisualDocumentChange(source, projection, content)).toBeNull();
    attributes.tex = projection.blocks[0]!.node.attrs!.tex;
    attributes.environment = "equation";
    expect(applyLatexVisualDocumentChange(source, projection, content)).toBeNull();
  });

  it("refuses an edit spanning a command inside a formula", () => {
    expect(
      patchNumberedMathSource("\\begin{equation}a \\label{middle} + b\\end{equation}", "c - d"),
    ).toBeNull();
  });

  it("keeps ambiguous or malformed numbering source protected", () => {
    expect(projectMathNumbering("x \\label{missing")).toBeNull();
    expect(projectMathNumbering("\\text{\\label{nested}}")).toBeNull();
    expect(
      parseLatexVisualMathSource(
        "\\begin{equation}x % comment\n\\label{eq:x}\\end{equation}",
        true,
      ),
    ).toBeNull();
  });
});
