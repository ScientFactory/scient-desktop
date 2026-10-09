import { describe, expect, it } from "vite-plus/test";

import { guidanceText, latexGuidance } from "./latexGuidance";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const document = (body: string) =>
  `\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{problem}{Problem}\n\\begin{document}\n${body}\\end{document}\n`;

describe("template guidance", () => {
  it("reads a marked comment, and never an ordinary one", () => {
    expect(guidanceText("% Guide: Explain the problem.\n%   and why.\n")).toBe(
      "Explain the problem. and why.",
    );
    expect(guidanceText("% TODO check the budget privately\n")).toBeNull();
    expect(guidanceText("\n")).toBeNull();
    expect(guidanceText("% Guide: A note.\nText.")).toBeNull();
  });

  it("finds guidance above an empty paragraph and inside an empty environment", () => {
    const source = document(
      "\\section{Introduction}\n% Guide: Explain the problem.\n\\par\n\n" +
        "\\begin{problem} [Warm-up]\n% Guide: State the problem.\n\\end{problem}\n\n" +
        "\\section{Methods}\nWe measured it.\n\n" +
        "% A private note.\n\\par\n\n" +
        "\\section{Results}\n",
    );
    const projection = projectLatexVisualDocument(source);
    const guidance = latexGuidance(projection);
    expect([...guidance.values()]).toEqual(["Explain the problem.", "State the problem."]);
    // Places are blocks by position: the page's top-level nodes, one for one.
    expect(projection.content.content).toHaveLength(projection.blocks.length);
    for (const index of guidance.keys())
      expect(["paragraph", "latexScientific"]).toContain(projection.blocks[index]!.node.type);
  });

  it("leaves a written paragraph alone", () => {
    const source = document(
      "\\section{Introduction}\n% Guide: Explain the problem.\nOur question.\n\n",
    );
    expect(latexGuidance(projectLatexVisualDocument(source)).size).toBe(0);
  });
});
