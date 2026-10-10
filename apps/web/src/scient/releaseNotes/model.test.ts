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

  it.each(["0.6.22", "0.6.23", "2.5.0", "2.5.0-rc.1"])(
    "allows longer paragraph notes for %s without a version exception",
    (version) => {
      const note = SCIENT_RELEASE_NOTES[0];
      expect(note.highlights).toHaveLength(9);
      expect(note.highlights[0].description.split("\n\n")).toHaveLength(2);
      expect(validateScientReleaseNotesCatalog([{ ...note, version }])).toEqual([]);
    },
  );

  it("keeps paragraph notes bounded at field and highlight limits", () => {
    const note = {
      ...paragraphRelease("2.5.0"),
      headline: "H".repeat(80),
      alsoIncluded: "A".repeat(400),
      highlights: [
        { id: "first", title: "T".repeat(72), description: "D".repeat(500) },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `extra-${index}`,
          title: "T",
          description: "D",
        })),
      ] as ScientReleaseNote["highlights"],
    };
    expect(validateScientReleaseNotesCatalog([note])).toEqual([]);
    expect(
      validateScientReleaseNotesCatalog([
        {
          ...note,
          headline: `${note.headline}H`,
          alsoIncluded: `${note.alsoIncluded}A`,
          highlights: [
            { id: "first", title: "T".repeat(73), description: "D".repeat(501) },
            ...note.highlights.slice(1),
            { id: "tenth", title: "T", description: "D" },
          ] as ScientReleaseNote["highlights"],
        },
      ]),
    ).toEqual([
      "release[0].headline must contain no more than 80 characters.",
      "release[0].alsoIncluded must contain no more than 400 characters.",
      "release[0].highlights must contain no more than 9 items.",
      "release[0].highlights[0].title must contain no more than 72 characters.",
      "release[0].highlights[0].description must contain no more than 500 characters.",
    ]);
  });

  it("accepts exactly 4000 visible characters and rejects 4001", () => {
    const note = {
      ...paragraphRelease("2.5.0"),
      headline: "H",
      alsoIncluded: "A".repeat(400),
      highlights: Array.from({ length: 9 }, (_, index) => ({
        id: `highlight-${index}`,
        title: "T",
        description: "D".repeat(index === 8 ? 377 : 400),
      })) as unknown as ScientReleaseNote["highlights"],
    };
    expect(validateScientReleaseNotesCatalog([note])).toEqual([]);
    expect(
      validateScientReleaseNotesCatalog([
        {
          ...note,
          headline: "HH",
        },
      ]),
    ).toEqual(["release[0] must contain no more than 4000 characters of visible copy."]);
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

  it("preserves the five-highlight limit and copy for historical legacy notes", () => {
    const note = release("2.6.0");
    const highlights = Array.from({ length: 5 }, (_, index) => ({
      id: `highlight-${index}`,
      title: "A historical title",
      description: "D".repeat(501),
    })) as unknown as ScientReleaseNote["highlights"];
    expect(validateScientReleaseNotesCatalog([{ ...note, highlights }])).toEqual([]);
    expect(
      validateScientReleaseNotesCatalog([
        {
          ...note,
          highlights: [...highlights, { id: "sixth", title: "Title", description: "Body" }],
        },
      ]),
    ).toEqual(["release[0].highlights must contain no more than five items."]);
  });
});

describe("Scient 0.6.23 release-note decision", () => {
  it("reuses the complete 0.6.22 note without changing its user-facing copy", () => {
    const previous = SCIENT_RELEASE_NOTES.find(({ version }) => version === "0.6.22");
    const current = SCIENT_RELEASE_NOTES.find(({ version }) => version === "0.6.23");
    expect(previous).toBeDefined();
    expect(current).toEqual({ ...previous, version: "0.6.23", publishedAt: "2026-10-10" });
  });

  it("shows the new note after upgrading and preserves the previous release in history", () => {
    const decision = resolveScientReleaseNotesDecision({
      catalog: SCIENT_RELEASE_NOTES,
      currentVersion: "0.6.23",
      lastHandledVersion: "0.6.22",
    });
    expect(decision.kind).toBe("show");
    if (decision.kind !== "show") throw new Error("Expected the new release note.");
    expect(decision.current.version).toBe("0.6.23");
    expect(decision.history.slice(0, 2).map(({ version }) => version)).toEqual([
      "0.6.23",
      "0.6.22",
    ]);
    expect(decision.nextLastHandledVersion).toBe("0.6.23");
  });
});

describe("Scient 0.6.12 release-note decision", () => {
  it("keeps the hotfix concise while carrying the approved 0.6.11 highlights", () => {
    const note = SCIENT_RELEASE_NOTES.find(({ version }) => version === "0.6.12") as
      | ScientReleaseNote
      | undefined;
    if (!note || note.format !== "paragraphs")
      throw new Error("Expected the 0.6.12 paragraph note.");
    expect(note.highlights[0]).toEqual({
      id: "gemini-model-discovery-hotfix",
      title: "Gemini model discovery hotfix",
      description: "Fixed Gemini model discovery for the Antigravity provider.",
    });
    expect(note.highlights.slice(1).map(({ title }) => title)).toEqual([
      "Bring your own models",
      "Pi is now available",
      "Continue your Codex and Claude conversations in Scient",
      "Set your preferences once",
      "Smoother Markdown editing",
      "Faster, more reliable work",
    ]);
    expect(note.alsoIncluded).toContain("originally released in Scient 0.6.11");
    expect(note.alsoIncluded).not.toContain("Windows");
  });
});
