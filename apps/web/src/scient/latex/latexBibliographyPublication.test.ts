import { describe, expect, it } from "vite-plus/test";
import { bibliographyChangePublished, mergeBibliographyChange } from "./latexBibliographyModel";

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

  it("confirms the submitted entry despite unrelated duplicate keys", () => {
    const unrelated = "\n" + bib("other", "First") + "\n" + bib("other", "Second");
    const before = bib("known", "Original") + unrelated,
      next = bib("known", "Entry A") + unrelated;
    expect(mergeBibliographyChange(before, next, before, "bibtex")).toBe(next);
    expect(bibliographyChangePublished(before, next, next, "bibtex")).toBe(true);
    expect(bibliographyChangePublished(before, unrelated, unrelated, "bibtex")).toBe(true);
    const repaired = bib("known", "Entry A") + "\n" + bib("other", "Second");
    expect(bibliographyChangePublished(before, next, repaired, "bibtex")).toBe(true);
    expect(
      mergeBibliographyChange(before, next, repaired.replace("Entry A", "Original"), "bibtex"),
    ).toBe(repaired);
  });

  it.each(["before", "after"])(
    "ignores an unrelated malformed entry appearing %s the submitted entry",
    (position) => {
      const before = bib("known", "Original"),
        next = bib("known", "Entry A");
      for (const malformed of ["@misc{unclosed,", "@misc{broken, invalid fields}"]) {
        const published = position === "before" ? malformed + "\n" + next : next + "\n" + malformed;
        expect(bibliographyChangePublished(before, next, published, "bibtex")).toBe(true);
        expect(bibliographyChangePublished(before, "", malformed, "bibtex")).toBe(true);
        const original =
          position === "before" ? malformed + "\n" + before : before + "\n" + malformed;
        expect(bibliographyChangePublished(original, published, published, "bibtex")).toBe(true);
      }
    },
  );

  it("confirms a manual entry independently of malformed unrelated items", () => {
    const before = manual("Original"),
      next = manual("Entry A");
    const malformed = "\\bibitem[unclosed{other} Unrelated broken item.\n";
    for (const marker of ["\\bibitem{known}", "\\end{thebibliography}"]) {
      const published = next.replace(marker, malformed + marker);
      expect(bibliographyChangePublished(before, next, published, "bibitem")).toBe(true);
    }
    const duplicate = next.replace(
      "\\end{thebibliography}",
      "\\bibitem{known} Duplicate.\n\\end{thebibliography}",
    );
    expect(bibliographyChangePublished(before, next, duplicate, "bibitem")).toBe(false);
  });

  it("refuses ambiguous or malformed submitted entries", () => {
    const before = bib("known", "Original"),
      next = bib("known", "Entry A");
    expect(bibliographyChangePublished(before, next, next + "\n" + next, "bibtex")).toBe(false);
    expect(bibliographyChangePublished(before, next, next + "\n@misc{known,", "bibtex")).toBe(
      false,
    );
    expect(
      bibliographyChangePublished(before, next, next + "\n@misc{known, invalid fields}", "bibtex"),
    ).toBe(false);
    expect(bibliographyChangePublished(before, "", "@misc{known,", "bibtex")).toBe(false);
    for (const current of [before + "\n" + before, next + "\n" + next]) {
      expect(mergeBibliographyChange(before, next, current, "bibtex")).toBeNull();
    }
    const duplicated = before + "\n" + before;
    expect(
      mergeBibliographyChange(duplicated, next + "\n" + before, duplicated, "bibtex"),
    ).toBeNull();
    expect(mergeBibliographyChange(duplicated, before, duplicated, "bibtex")).toBeNull();
  });
});
