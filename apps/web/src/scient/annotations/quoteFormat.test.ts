import { describe, expect, it } from "vitest";

import { latexInlineCommandSource } from "../latex/latexVisualDocument";
import { latexQuote, markdownQuote } from "./quoteFormat";

const passage = {
  quote: "Deep sleep doubled re-\ncall in\nmice.",
  pages: [4],
  citationKey: "smith2024sleep",
  fileName: "sleep.pdf",
};

describe("quotes for documents", () => {
  it("cites a Library source with its key and page in Markdown and LaTeX", () => {
    expect(markdownQuote(passage)).toEqual({
      text: "Deep sleep doubled recall in mice.",
      citation: "@smith2024sleep, p. 4",
      reference: "[@smith2024sleep, p. 4]",
      markdown: "> Deep sleep doubled recall in mice. [@smith2024sleep, p. 4]",
    });
    const latex = latexQuote({ ...passage, pages: [4, 5] });
    expect(latex).toEqual({
      text: "“Deep sleep doubled recall in mice.” ",
      cite: { key: "smith2024sleep", raw: "\\cite[pp.~4–5]{smith2024sleep}" },
    });
    // The visual editor writes the inserted citation back with its page.
    expect(latexInlineCommandSource("cite", "smith2024sleep", "", latex.cite!.raw)).toBe(
      latex.cite!.raw,
    );
  });

  it("names the file and page when the PDF has no citation key", () => {
    const loose = { ...passage, citationKey: null };
    expect(markdownQuote(loose).markdown).toBe(
      "> Deep sleep doubled recall in mice. (sleep.pdf, p. 4)",
    );
    expect(latexQuote(loose)).toEqual({
      text: "“Deep sleep doubled recall in mice.” (sleep.pdf, p. 4)",
      cite: null,
    });
  });
});
