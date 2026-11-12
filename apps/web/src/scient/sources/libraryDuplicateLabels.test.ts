import { describe, expect, it } from "vite-plus/test";

import {
  DUPLICATE_LABELS,
  differsLabel,
  DUPLICATE_FIELDS,
  keptDifferentLabel,
  mergeDifferenceLabel,
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
      mergedRowLabel({ mergedTitle: "A", kept: null, differences: [] }),
      mergedRowLabel({ mergedTitle: "A", kept: { title: "B" }, differences: [] }),
      mergedRowLabel({
        mergedTitle: "A",
        kept: { title: "A" },
        differences: [{ field: "creators" }, { field: "identifiers" }],
      }),
      mergeDifferenceLabel({ field: "volume", kept: null, other: "12" }),
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
    // Two copies with one title are told apart by what differed, each with both values.
    expect(
      mergedRowLabel({
        mergedTitle: "Shock trial",
        kept: { title: "Shock trial" },
        differences: [{ field: "creators" }, { field: "identifiers" }, { field: "attachments" }],
      }),
    ).toBe("Two copies of “Shock trial” merged. Their authors, identifiers and PDF differed.");
    expect(mergeDifferenceLabel({ field: "volume", kept: null, other: "12" })).toBe(
      "Volume: none (kept), 12 (merged away)",
    );
    // Undo can name any field the merge set; none is shown by its key.
    expect(unrevertedLabel(["abstract", "abstractSections", "note", "someNewField"])).toBe(
      "Changes made after the merge were kept: abstract, note and other details.",
    );
  });
});
