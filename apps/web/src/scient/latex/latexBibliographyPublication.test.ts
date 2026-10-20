import { describe, expect, it } from "vite-plus/test";
import { bibliographyChangePublished, mergeBibliographySourceEdit } from "./latexBibliographyModel";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import { invertLatexSourcePatches } from "./latexSourceEditPlan";

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
    expect(mergeBibliographySourceEdit(before, next, before, "bibtex")?.source).toBe(next);
    expect(bibliographyChangePublished(before, next, next, "bibtex")).toBe(true);
    expect(bibliographyChangePublished(before, unrelated, unrelated, "bibtex")).toBe(true);
    const repaired = bib("known", "Entry A") + "\n" + bib("other", "Second");
    expect(bibliographyChangePublished(before, next, repaired, "bibtex")).toBe(true);
    expect(
      mergeBibliographySourceEdit(before, next, repaired.replace("Entry A", "Original"), "bibtex")
        ?.source,
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
      expect(mergeBibliographySourceEdit(before, next, current, "bibtex")).toBeNull();
    }
    const duplicated = before + "\n" + before;
    expect(
      mergeBibliographySourceEdit(duplicated, next + "\n" + before, duplicated, "bibtex"),
    ).toBeNull();
    expect(mergeBibliographySourceEdit(duplicated, before, duplicated, "bibtex")).toBeNull();
  });

  it.each(["bibtex", "bibitem"] as const)(
    "owns only the changed entry when rebasing %s over unrelated writing",
    (kind) => {
      const before = kind === "bibtex" ? bib("known", "Original") : manual("Original");
      const next = before.replace("Original", "New");
      const current = "% concurrent author comment 😀\r\n" + before;
      const merged = mergeBibliographySourceEdit(before, next, current, kind)!;
      expect(merged.source).toBe(current.replace("Original", "New"));
      expect(applyDocumentSourcePatches(current, merged.edit.patches)).toBe(merged.source);
      expect(merged.edit.patches).toEqual([
        {
          start: current.indexOf("Original"),
          end: current.indexOf("Original") + "Original".length,
          expected: "Original",
          replacement: "New",
        },
      ]);
      expect(
        applyDocumentSourcePatches(
          merged.source,
          invertLatexSourcePatches(current, merged.edit.patches),
        ),
      ).toBe(current);
      expect(
        mergeBibliographySourceEdit(before, next, current.replace("Original", "Other"), kind),
      ).toBeNull();
    },
  );

  it.each(["bibtex", "bibitem"] as const)(
    "uses the explicit append/container boundary for a new %s entry",
    (kind) => {
      const before = kind === "bibtex" ? bib("known", "Existing") : manual("Existing");
      const addition =
        kind === "bibtex" ? "\n\n" + bib("new", "Added") + "\n" : "\\bibitem{new} Added.\n";
      const next =
        kind === "bibtex"
          ? before + addition
          : before.replace("\\end{thebibliography}", addition + "\\end{thebibliography}");
      const merged = mergeBibliographySourceEdit(before, next, before, kind)!;
      expect(applyDocumentSourcePatches(before, merged.edit.patches)).toBe(next);
      expect(merged.edit.patches.every((patch) => patch.start === patch.end)).toBe(true);
      expect(
        applyDocumentSourcePatches(next, invertLatexSourcePatches(before, merged.edit.patches)),
      ).toBe(before);
    },
  );
});
