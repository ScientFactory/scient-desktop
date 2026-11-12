import { describe, expect, it } from "vite-plus/test";

import {
  DUPLICATE_LABELS,
  differsLabel,
  DUPLICATE_FIELDS,
  keptDifferentLabel,
  mergedRowLabel,
  mergedTitleLabel,
  otherProjectsLabel,
  shownOfTotalLabel,
  undoProblem,
  unrevertedLabel,
} from "./libraryDuplicateLabels";

describe("possible-duplicate labels", () => {
  it("use none of the engine's words", () => {
    const fields = ["title", "creators", "containerTitle", "identifiers", "url"];
    const shown = [
      ...Object.values(DUPLICATE_LABELS),
      differsLabel(DUPLICATE_FIELDS),
      differsLabel([]),
      keptDifferentLabel(fields) ?? "",
      mergedRowLabel("A", null),
      mergedRowLabel("A", { title: "B" }),
      mergedTitleLabel(null),
      otherProjectsLabel(["Grant", "Thesis"]) ?? "",
      shownOfTotalLabel(200, 340) ?? "",
      unrevertedLabel(fields) ?? "",
      ...(["already-undone", "survivor-missing", "loser-missing", "not-found"] as const).map(
        (outcome) => undoProblem({ outcome }) ?? "",
      ),
    ];
    expect(shown.filter((text) => /pin|alias|survivor|loser|record/iu.test(text))).toEqual([]);
  });

  it("names the fields that kept the kept source's value in plain words", () => {
    expect(keptDifferentLabel(["containerTitle", "issuedYear", "issuedRaw"])).toBe(
      "Where they differed, the kept one's journal, year and date stayed.",
    );
    expect(keptDifferentLabel([])).toBeNull();
    // Undo can name any field the merge set; none is shown by its key.
    expect(unrevertedLabel(["abstract", "abstractSections", "note", "someNewField"])).toBe(
      "Changes made after the merge were kept: abstract, note and other details.",
    );
  });
});
