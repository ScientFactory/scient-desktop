import { describe, expect, it } from "vite-plus/test";

import { guidanceText, latexGuidance } from "./latexGuidance";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const document = (body: string) =>
  `\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{problem}{Problem}\n\\begin{document}\n${body}\\end{document}\n`;

describe("template guidance", () => {
  it("reads comment lines and nothing else", () => {
    expect(guidanceText("% Explain the problem.\n%   and why.\n")).toBe(
      "Explain the problem. and why.",
    );
    expect(guidanceText("\n")).toBeNull();
    expect(guidanceText("% A note.\nText.")).toBeNull();
  });

  it("finds guidance above an empty paragraph and inside an empty environment", () => {
    const source = document(
      "\\section{Introduction}\n% Explain the problem.\n\\par\n\n" +
        "\\begin{problem}\n% State the problem.\n\\end{problem}\n\n" +
        "\\section{Methods}\nWe measured it.\n\n" +
        "% A note that guides nothing.\n\\section{Results}\n",
    );
    const projection = projectLatexVisualDocument(source);
    expect([...latexGuidance(projection).values()]).toEqual([
      "Explain the problem.",
      "State the problem.",
    ]);
  });

  it("leaves a written paragraph alone", () => {
    const source = document("\\section{Introduction}\n% Explain the problem.\nOur question.\n\n");
    expect(latexGuidance(projectLatexVisualDocument(source)).size).toBe(0);
  });
});
