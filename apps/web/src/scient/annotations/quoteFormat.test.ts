import { describe, expect, it } from "vitest";

import { latexInlineCommandSource } from "../latex/latexVisualDocument";
import { scientMarkdownParser } from "../markdownEditor/prosemirror/schema";
import { latexQuote, markdownQuote, quotePageLabels } from "./quoteFormat";

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

  it("cites the printed page when the PDF labels its pages", () => {
    // A journal article whose ten PDF pages are printed 1121 to 1130.
    const journal = Array.from({ length: 10 }, (_, index) => String(1121 + index));
    const pages = [3, 4];
    const labelled = { ...passage, pages, pageLabels: quotePageLabels(pages, journal) };
    expect(markdownQuote(labelled).reference).toBe("[@smith2024sleep, pp. 1123–1124]");
    expect(latexQuote(labelled).cite?.raw).toBe("\\cite[pp.~1123–1124]{smith2024sleep}");
    expect(markdownQuote({ ...labelled, citationKey: null }).reference).toBe(
      "(sleep.pdf, pp. 1123–1124)",
    );
    const front = ["i", "ii", "iii", "1", "2"];
    expect(
      markdownQuote({ ...passage, pages: [2], pageLabels: quotePageLabels([2], front) }).reference,
    ).toBe("[@smith2024sleep, p. ii]");
  });

  it("keeps the PDF page numbers when the PDF has no labels for every quoted page", () => {
    expect(quotePageLabels([4], null)).toBeNull();
    expect(quotePageLabels([2, 3], ["i", "ii", ""])).toBeNull();
    expect(quotePageLabels([4], ["i", "ii"])).toBeNull();
    const unlabelled = { ...passage, pageLabels: quotePageLabels([4], null) };
    expect(markdownQuote(unlabelled).reference).toBe("[@smith2024sleep, p. 4]");
    expect(latexQuote(unlabelled).cite?.raw).toBe("\\cite[p.~4]{smith2024sleep}");
  });

  it("keeps math and citation syntax in a passage literal in Markdown", () => {
    const quote = "$x$ [@wrong] \\input{evil} ] @ # _ % & <b>";
    const parsed = scientMarkdownParser.parse(
      markdownQuote({ ...passage, quote, pages: [1], citationKey: "right" }).markdown,
    );
    const inline: string[] = [];
    parsed.descendants((node) => {
      if (node.isInline) inline.push(node.text ?? `${node.type.name}:${String(node.attrs.source)}`);
    });
    expect(inline).toEqual([`${quote} `, "citation:@right, p. 1"]);
  });
});
