import { describe, expect, it } from "vite-plus/test";

import {
  addedToProjectLabel,
  alsoInOtherProjectsLabel,
  inLibraryNotProjectLabel,
  LIBRARY_LABELS,
  readingResultLabel,
  removedFromProjectLabel,
  someAlsoInOtherProjectsLabel,
} from "./libraryLabels";
import { sourcePinLabel } from "./sourceLabels";

const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(strings)
      : [];

describe("library labels", () => {
  it("never call a source pinned", () => {
    const shown = [
      ...strings(LIBRARY_LABELS),
      ...[1, 2].flatMap((count) => [
        addedToProjectLabel(count),
        removedFromProjectLabel(count),
        alsoInOtherProjectsLabel(count) ?? "",
        someAlsoInOtherProjectsLabel(count),
        inLibraryNotProjectLabel(count),
      ]),
      sourcePinLabel({ pinned: true }, "library"),
      sourcePinLabel({ pinned: true, fromSnapshot: true }, "project"),
    ];
    expect(shown.filter((text) => /pin/iu.test(text))).toEqual([]);
  });

  it("counts sources no longer in the Library apart from the changed ones", () => {
    expect(
      readingResultLabel(
        { readingStatus: "read" },
        {
          sources: [
            { sourceId: "a", outcome: "updated", readingStatus: "read", starred: false },
            { sourceId: "b", outcome: "unchanged", readingStatus: "read", starred: true },
            { sourceId: "gone", outcome: "not-found" },
          ],
        },
      ),
    ).toEqual({
      title: "Marked 2 sources read",
      description: "1 source is no longer in the Library.",
    });
  });
});
