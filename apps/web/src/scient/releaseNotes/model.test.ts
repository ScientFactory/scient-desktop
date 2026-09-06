import { describe, expect, it } from "vite-plus/test";

import { SCIENT_RELEASE_NOTES } from "./catalog";
import {
  formatScientReleaseMonth,
  formatScientReleaseVersion,
  resolveScientReleaseNotesDecision,
  sortScientReleaseNotes,
  validateScientReleaseNotesCatalog,
  type ScientParagraphReleaseNote,
  type ScientReleaseNote,
} from "./model";

function release(version: string, publishedAt = "2030-03-04"): ScientReleaseNote {
  return {
    version,
    publishedAt,
    kicker: "A focused update",
    headline: `Release ${version}`,
    summary: "A concise summary of the user-facing improvement.",
    highlights: [
      {
        id: `highlight-${version}`,
        title: "A clearer workflow",
        description: "The workflow is easier to understand and complete.",
      },
    ],
  };
}

function paragraphRelease(version: string): ScientParagraphReleaseNote {
  return {
    version,
    publishedAt: "2030-03-04",
    format: "paragraphs",
    headline: `Release ${version}`,
    highlights: [
      {
        id: `highlight-${version}`,
        title: "A clearer workflow",
        description: "The workflow is easier to understand and complete.",
      },
    ],
    alsoIncluded: "Several smaller reliability and interface improvements.",
  };
}

describe("resolveScientReleaseNotesDecision", () => {
  const catalog = [release("2.2.0"), release("2.4.0"), release("2.3.0")];

  it("stays quiet on first launch and records the installed version", () => {
    expect(
      resolveScientReleaseNotesDecision({
        catalog,
        currentVersion: "2.4.0",
        lastHandledVersion: null,
      }),
    ).toEqual({ kind: "silent-bootstrap", nextLastHandledVersion: "2.4.0" });
  });

  it("shows only an exact current-version note after an upgrade", () => {
    const decision = resolveScientReleaseNotesDecision({
      catalog,
      currentVersion: "2.4.0",
      lastHandledVersion: "2.3.0",
    });

    expect(decision.kind).toBe("show");
    if (decision.kind !== "show") throw new Error("Expected a visible release note.");
    expect(decision.current.version).toBe("2.4.0");
    expect(decision.history.map((note) => note.version)).toEqual(["2.4.0", "2.3.0", "2.2.0"]);
  });

  it("silently advances when approved copy is absent", () => {
    expect(
      resolveScientReleaseNotesDecision({
        catalog: [release("2.3.0")],
        currentVersion: "2.4.0",
        lastHandledVersion: "2.3.0",
      }),
    ).toEqual({ kind: "silent-bootstrap", nextLastHandledVersion: "2.4.0" });
  });

  it("does not repeat handled releases or move backward after a downgrade", () => {
    expect(
      resolveScientReleaseNotesDecision({
        catalog,
        currentVersion: "2.4.0",
        lastHandledVersion: "2.4.0",
      }),
    ).toEqual({ kind: "noop" });
    expect(
      resolveScientReleaseNotesDecision({
        catalog,
        currentVersion: "2.3.0",
        lastHandledVersion: "2.4.0",
      }),
    ).toEqual({ kind: "noop" });
  });
});

describe("Scient release-note presentation helpers", () => {
  it("sorts versions numerically without mutating the catalog", () => {
    const input = [release("2.9.0"), release("2.10.0")];
    expect(sortScientReleaseNotes(input).map((note) => note.version)).toEqual(["2.10.0", "2.9.0"]);
    expect(input.map((note) => note.version)).toEqual(["2.9.0", "2.10.0"]);
  });

  it("formats stable labels and release months deterministically", () => {
    expect(formatScientReleaseVersion("v2.4.0")).toBe("2.4");
    expect(formatScientReleaseVersion("2.4.3")).toBe("2.4.3");
    expect(formatScientReleaseVersion("2.4.0-rc.1")).toBe("2.4.0-rc.1");
    expect(formatScientReleaseMonth("2030-03-04")).toBe("March 2030");
  });
});

describe("validateScientReleaseNotesCatalog", () => {
  it("keeps every future production catalog entry within the content contract", () => {
    expect(validateScientReleaseNotesCatalog(SCIENT_RELEASE_NOTES)).toEqual([]);
  });

  it("rejects duplicate versions, invalid dates, empty copy, and duplicate highlight ids", () => {
    const first = release("2.4.0", "2030-02-30");
    const invalid = {
      ...release("2.4.0"),
      headline: " ",
      highlights: [first.highlights[0], first.highlights[0]],
    } satisfies ScientReleaseNote;

    expect(validateScientReleaseNotesCatalog([first, invalid])).toEqual([
      "release[0].publishedAt must be a valid YYYY-MM-DD date.",
      "release[1].version duplicates 2.4.0.",
      "release[1].headline must not be empty.",
      "release[1].highlights[1].id duplicates highlight-2.4.0 in this release.",
    ]);
  });

  it("accepts seven dedicated paragraphs plus Also included and rejects a longer note", () => {
    const highlights: ScientReleaseNote["highlights"] = [
      {
        id: "highlight-0",
        title: "Highlight 0",
        description: "A user-facing improvement.",
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `highlight-${index + 1}`,
        title: `Highlight ${index + 1}`,
        description: "A user-facing improvement.",
      })),
    ];
    const withinLimit = { ...paragraphRelease("2.5.0"), highlights };
    const tooMany = {
      ...withinLimit,
      highlights: [
        ...highlights,
        { id: "highlight-7", title: "Highlight 7", description: "A user-facing improvement." },
      ] as unknown as ScientReleaseNote["highlights"],
    };

    expect(validateScientReleaseNotesCatalog([withinLimit])).toEqual([]);
    expect(validateScientReleaseNotesCatalog([tooMany])).toContain(
      "release[0].highlights must contain no more than seven items.",
    );
  });

  it("bounds each paragraph and the total visible copy in the current format", () => {
    const oversizedFields = {
      ...paragraphRelease("2.6.0"),
      headline: "H".repeat(81),
      highlights: [
        {
          id: "oversized",
          title: "T".repeat(73),
          description: "D".repeat(241),
        },
      ] as ScientReleaseNote["highlights"],
      alsoIncluded: "A".repeat(321),
    } satisfies ScientReleaseNote;
    const excessiveTotal = {
      ...paragraphRelease("2.7.0"),
      highlights: Array.from({ length: 7 }, (_, index) => ({
        id: `highlight-${index}`,
        title: `Highlight ${index}`,
        description: "D".repeat(220),
      })) as unknown as ScientReleaseNote["highlights"],
    } satisfies ScientReleaseNote;

    expect(validateScientReleaseNotesCatalog([oversizedFields])).toEqual([
      "release[0].headline must contain no more than 80 characters.",
      "release[0].alsoIncluded must contain no more than 320 characters.",
      "release[0].highlights[0].title must contain no more than 72 characters.",
      "release[0].highlights[0].description must contain no more than 240 characters.",
    ]);
    expect(validateScientReleaseNotesCatalog([excessiveTotal])).toContain(
      "release[0] must contain no more than 1600 characters of visible copy.",
    );
  });
});
