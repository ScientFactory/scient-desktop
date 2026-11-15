import type {
  ScientSourcesJoinDifferenceRow,
  ScientSourcesJoinDifferences,
  ScientSourcesOrganizeResult,
} from "@t3tools/contracts";

export const JOIN_DIFFERENCES_LABELS = {
  open: "Show differences",
  title: "Papers both Libraries have",
  empty: "Nothing differs any more.",
  more: "Show more",
  here: "Here",
  addNote: "Add to my note",
  useNote: "Use this note",
  attach: "Attach",
  addSeparately: "Add separately",
  removedHere: "Removed here, still in the other Library (not brought back)",
  untitled: "Untitled source",
  none: "(none)",
} as const;

const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

/** The other Library, as a short name for column heads and sentences. */
export function otherLibraryName(listed: ScientSourcesJoinDifferences): string {
  if (listed.from === "replaced") return "The Library a restore replaced";
  return listed.backupCreatedAt ? `Backup of ${day(listed.backupCreatedAt)}` : "The backup";
}

/** What the list is, and that looking at it changes nothing. */
export function differencesIntro(listed: ScientSourcesJoinDifferences): string {
  return `These papers are in this Library and in ${otherLibraryName(listed)
    .replace(/^The /u, "the ")
    .replace(
      /^Backup/u,
      "the backup",
    )}, and the other one has something this one lacks. Nothing here was changed. Take what you want, one thing at a time; each is an ordinary edit of the paper.`;
}

/** Said while the folder that was read cannot be read. */
export function differencesAway(listed: ScientSourcesJoinDifferences): string {
  return `The other Library's folder is not there now (${listed.folder}), so its versions cannot be shown or taken. The list below is what was recorded when the sources were added.`;
}

const titleOf = (title: string | null | undefined) =>
  title?.trim() || JOIN_DIFFERENCES_LABELS.untitled;

/** How the two papers stand to each other, in plain words. */
export function relationLabel(row: ScientSourcesJoinDifferenceRow): string {
  switch (row.relation) {
    case "same-id":
      return "Saved in both Libraries";
    case "merged-here":
      return `Merged here into “${titleOf(row.here?.title)}”`;
    case "rebuilt-there":
      return "The other Library's copy was rebuilt from a project and may lack details";
    case "rebuilt-here":
      return "The copy here was rebuilt from a project and may lack details";
    case "same-paper":
      return "The same paper, entered separately in each Library";
    case "possibly-same":
      return row.candidates.length > 1
        ? `May be one of these papers here: ${row.candidates.map((candidate) => `“${titleOf(candidate.title)}”`).join(", ")}`
        : "May be the same paper as this one here";
  }
}

/** The paper's name on its row: this Library's title, or the other's when none here is named. */
export function rowTitle(row: ScientSourcesJoinDifferenceRow): string {
  return titleOf(row.here?.title ?? row.other?.title ?? row.otherTitle);
}

const PART_WORDS: Record<ScientSourcesJoinDifferenceRow["parts"][number], string> = {
  details: "details",
  tags: "tags",
  note: "a note",
  reading: "read or star",
  pdfs: "PDFs",
  highlights: "highlights",
};

/** What was recorded as differing, for a row whose other version cannot be read now. */
export function recordedParts(row: ScientSourcesJoinDifferenceRow): string {
  return row.parts.length > 0
    ? `The other Library has more: ${row.parts.map((part) => PART_WORDS[part]).join(", ")}.`
    : "";
}

/** What an action did not do, as a sentence; null when it was done. */
export function takeProblem(outcome: ScientSourcesOrganizeResult["outcome"]): string | null {
  switch (outcome) {
    case "taken":
    case "take-already":
      return null;
    case "take-changed":
      return "One of the two papers changed since this list was shown, so nothing was done. The list is up to date now.";
    case "take-unavailable":
      return "The other Library's folder or that file is not there now, so nothing was done.";
    case "take-too-long":
      return "The two notes together are longer than a note can be, so nothing was added. Shorten the note here, or copy the part you want.";
    default:
      return "Nothing was done.";
  }
}
