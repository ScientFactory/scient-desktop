import type {
  ScientSourcesJoinDifferenceRow,
  ScientSourcesJoinDifferences,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  differencesAway,
  otherLibraryName,
  recordedParts,
  relationLabel,
  rowTitle,
  takeProblem,
} from "./joinDifferenceLabels";

const row = (
  overrides: Partial<ScientSourcesJoinDifferenceRow>,
): ScientSourcesJoinDifferenceRow => ({
  otherSourceId: "source_other",
  relation: "same-id",
  parts: [],
  here: null,
  candidates: [],
  other: null,
  otherTitle: "The other title",
  details: [],
  ...overrides,
});
const listed = (
  overrides: Partial<ScientSourcesJoinDifferences>,
): ScientSourcesJoinDifferences => ({
  joinId: "join_1",
  from: "backup",
  backupCreatedAt: "2026-11-14T07:00:00.000Z",
  folder: "/backups/one",
  available: true,
  total: 0,
  nextOffset: null,
  rows: [],
  removedHere: [],
  ...overrides,
});

describe("wording of the differences between two Libraries", () => {
  it("says in plain words how two papers stand", () => {
    expect(relationLabel(row({}))).toBe("Saved in both Libraries");
    expect(relationLabel(row({ relation: "same-paper" }))).toBe(
      "The same paper, entered separately in each Library",
    );
    expect(relationLabel(row({ relation: "possibly-same" }))).toBe(
      "May be the same paper as this one here",
    );
    expect(
      relationLabel(
        row({
          relation: "possibly-same",
          candidates: [
            { sourceId: "a", title: "Soil carbon" },
            { sourceId: "b", title: null },
          ],
        }),
      ),
    ).toBe("May be one of these papers here: “Soil carbon”, “Untitled source”");
    expect(relationLabel(row({ relation: "rebuilt-here" }))).toContain("rebuilt from a project");
  });

  it("names a paper by this Library's title, else the other's, also when its folder is away", () => {
    expect(rowTitle(row({}))).toBe("The other title");
    expect(rowTitle(row({ otherTitle: null }))).toBe("Untitled source");
    expect(recordedParts(row({ parts: ["note", "pdfs"] }))).toBe(
      "The other Library has more: a note, PDFs.",
    );
  });

  it("names the other Library and says where its folder was", () => {
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date("2026-11-14T07:00:00.000Z"),
    );
    expect(otherLibraryName(listed({}))).toBe(`Backup of ${day}`);
    expect(otherLibraryName(listed({ from: "replaced", backupCreatedAt: null }))).toBe(
      "The Library a restore replaced",
    );
    expect(differencesAway(listed({}))).toContain("(/backups/one)");
  });

  it("says why an action did nothing", () => {
    expect(takeProblem("taken")).toBeNull();
    expect(takeProblem("take-already")).toBeNull();
    expect(takeProblem("take-changed")).toContain("changed since this list was shown");
    expect(takeProblem("take-too-long")).toContain("longer than a note can be");
    expect(takeProblem("take-unavailable")).toContain("not there now");
  });
});
