import { describe, expect, it } from "vite-plus/test";
import { bibliographyChangePublished } from "./latexBibliographyModel";

describe("bibliography publication confirmation", () => {
  const bib = (key: string, title: string) => `@misc{${key},\n  title = {${title}},\n}`;
  const manual = (body: string) =>
    `\\begin{thebibliography}{99}\n\\bibitem{known} ${body}\n\\end{thebibliography}`;

  it("requires the submitted key and text while allowing unrelated published edits", () => {
    const before = bib("known", "Original"),
      next = bib("known", "Entry A");
    expect(
      bibliographyChangePublished(before, next, next + "\n" + bib("other", "B"), "bibtex"),
    ).toBe(true);
    expect(bibliographyChangePublished(before, next, bib("known", "Entry B"), "bibtex")).toBe(
      false,
    );
    expect(bibliographyChangePublished(before, next, bib("other", "Entry A"), "bibtex")).toBe(
      false,
    );
  });

  it("confirms a removal only when its key is absent", () => {
    const before = bib("known", "Original");
    expect(bibliographyChangePublished(before, "", bib("other", "B"), "bibtex")).toBe(true);
    expect(bibliographyChangePublished(before, "", bib("known", "Entry B"), "bibtex")).toBe(false);
  });

  it("matches manual entry text across file line endings", () => {
    const before = manual("Original"),
      next = manual("Entry A");
    expect(bibliographyChangePublished(before, next, next.replace(/\n/gu, "\r\n"), "bibitem")).toBe(
      true,
    );
    expect(bibliographyChangePublished(before, next, manual("Entry B"), "bibitem")).toBe(false);
  });

  it("refuses ambiguous or malformed published entries", () => {
    const before = bib("known", "Original"),
      next = bib("known", "Entry A");
    expect(bibliographyChangePublished(before, next, next + "\n" + next, "bibtex")).toBe(false);
    expect(bibliographyChangePublished(before, next, next + "\n@misc{unclosed,", "bibtex")).toBe(
      false,
    );
  });
});
