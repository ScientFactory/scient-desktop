import { describe, expect, it } from "vite-plus/test";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import {
  composeLatexSourcePatches,
  latexCommands,
  latexDocumentBoundary,
  latexPreambleEnd,
  latexSourceArgument,
  latexSourceCommands,
  maskLatexSource,
} from "./latexSourceSyntax";
import { latexPackageInventory } from "./latexPackages";
import { projectLatexVisualDocument } from "./latexVisualDocument";

describe("lossless native lexical boundaries", () => {
  it.each([
    "% \\begin{document}\n",
    "\\verb|\\begin{document}|\n",
    "\\newcommand{\\later}{\\begin{document}}\n",
    "\\begin{comment}\\begin{document}\\end{comment}\n",
    "\\\\begin{document}\n",
    "% \\begin{document}\n".repeat(10),
  ])("finds the active preamble boundary after %s", (prefix) => {
    const source = `${prefix}\\begin% comment\n{document}Body\\end{document}`;
    expect(latexPreambleEnd(source)).toBe(prefix.length);
    expect(latexPreambleEnd(source)).toBe(latexDocumentBoundary(source)?.from);
  });

  it.each([
    "\\newcommand{\\hiddenBegin}{\\begin{comment}}",
    "\\renewcommand *{\\hiddenBegin}[1][default]{\\begin{comment}#1}",
    "\\providecommand\\hiddenBegin{\\begin{verbatim}}",
    "\\def\\hiddenBegin#1{\\begin{comment}#1}",
    "\\newenvironment{hidden}{\\begin{comment}}{\\end{comment}}",
    "\\NewDocumentCommand{\\hiddenBegin}{m}{\\begin{comment}#1}",
    "\\newcommand% name follows\n\\hiddenBegin{\\begin{comment}}",
    "\\newcommand% name follows\r\n\\hiddenBegin{\\begin{comment}}",
    "\\newcommand% star follows\n*{\\hiddenBegin}{\\begin{comment}}",
    "\\newcommand% star follows\r\n*{\\hiddenBegin}{\\begin{comment}}",
    "\\DeclareDocumentCommand{\\hiddenBegin}{m}{\\begin{comment}#1}",
  ])("does not execute an environment opening inside %s", (definition) => {
    const source = `\\documentclass{article}\n${definition}\n\\begin{document}\nActual body.\n\\end{document}`;
    expect(latexDocumentBoundary(source)?.from).toBe(source.indexOf("\\begin{document}"));
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks).toHaveLength(1);
    expect(projection.blocks[0]).toMatchObject({ editable: true, source: "Actual body." });
  });

  it("still masks active opaque environments inside an ordinary group", () => {
    const source =
      "{\\begin{comment}\n}\\begin{document}\n\\end{comment}}\n\\begin{document}\nActual body.\n\\end{document}";
    expect(latexDocumentBoundary(source)?.from).toBe(source.lastIndexOf("\\begin{document}"));
  });

  it("retains UTF-16 offsets and CRLF while masking comments, literals and opaque environments", () => {
    const source =
      "😀\\title{Real} % 😀 hidden\\title{Fake}\r\n\\verb|%\\input{literal}|\r\n\\begin{comment}\r\n\\input{opaque}\r\n\\end{comment}\r\n\\input{active}";
    const masked = maskLatexSource(source, { literals: true, opaqueEnvironments: ["comment"] });
    expect(masked.length).toBe(source.length);
    expect([...masked.matchAll(/\r\n/gu)].map((match) => match.index)).toEqual(
      [...source.matchAll(/\r\n/gu)].map((match) => match.index),
    );
    expect(masked.indexOf("\\input{active}")).toBe(source.indexOf("\\input{active}"));
    expect([...masked.matchAll(/\\input/gu)].map((match) => match.index)).toEqual([
      source.indexOf("\\input{active}"),
    ]);
  });

  it("excludes literal and opaque declarations from boundary and package interpretation", () => {
    const source =
      "\\documentclass{article}\n\\begin{comment}\n\\usepackage{amssymb}\n\\begin{document}\n\\end{comment}\n\\verb|\\usepackage{amsmath}|\n\\begin{document}\nBody\n\\end{document}";
    expect(latexDocumentBoundary(source)?.from).toBe(source.lastIndexOf("\\begin{document}"));
    expect(latexPackageInventory(source).loaded.has("amssymb")).toBe(false);
    expect(latexPackageInventory(source).loaded.has("amsmath")).toBe(false);
    expect(latexSourceCommands(source).filter((command) => command.name === "usepackage")).toEqual(
      [],
    );
    expect(latexCommands(source).map((command) => command[1])).not.toContain("usepackage");
  });

  it("keeps active TeX in alltt unless a display consumer explicitly treats it as literal", () => {
    const source = "\\begin{alltt}\\input{active}\\end{alltt}";
    expect(maskLatexSource(source, { literals: true })).toContain("\\input{active}");
    expect(maskLatexSource(source, { literals: true, literalAlltt: true }).trim()).toBe("");
  });

  it("balances optional arguments without mistaking braces, escaped delimiters or comments for boundaries", () => {
    const source = " % lead\r\n[short {nested ]} \\] % hidden ]\r\n tail]suffix";
    const argument = latexSourceArgument(source, 0, "[", "]")!;
    expect(source.slice(argument.from, argument.to)).toBe(
      "short {nested ]} \\] % hidden ]\r\n tail",
    );
    expect(source.slice(argument.end)).toBe("suffix");
    expect(latexSourceArgument("{unterminated % }", 0)).toBeNull();
  });

  it("composes explicit staged ranges without owning the surviving source between them", () => {
    const source = "A 😀 unchanged B\r\nC";
    const first = [{ start: 0, end: 1, expected: "A", replacement: "First" }];
    const intermediate = applyDocumentSourcePatches(source, first);
    const end = intermediate.indexOf("C");
    const second = [{ start: end, end: end + 1, expected: "C", replacement: "Last" }];
    const composed = composeLatexSourcePatches(source, [first, second]);
    expect(applyDocumentSourcePatches(source, composed)).toBe("First 😀 unchanged B\r\nLast");
    expect(composed).toEqual([
      { start: 0, end: 1, expected: "A", replacement: "First" },
      { start: source.length - 1, end: source.length, expected: "C", replacement: "Last" },
    ]);
  });

  it("preserves insertion order and original ownership when a later edit revises newly inserted text", () => {
    const source = "left|right";
    const first = [
      { start: 5, end: 5, expected: "", replacement: "one" },
      { start: 5, end: 5, expected: "", replacement: "two" },
    ];
    const intermediate = applyDocumentSourcePatches(source, first);
    expect(intermediate).toBe("left|onetworight");
    const second = [{ start: 5, end: 8, expected: "one", replacement: "ONE" }];
    const composed = composeLatexSourcePatches(source, [first, second]);
    expect(applyDocumentSourcePatches(source, composed)).toBe("left|ONEtworight");
    expect(composed).toEqual([{ start: 5, end: 5, expected: "", replacement: "ONEtwo" }]);
  });
});
