import type {
  ScientSourcesJoinDifferenceRow,
  ScientSourcesJoinDifferences,
  ScientSourcesOrganizeResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import { dayLabel } from "./dayLabel";

export const JOIN_DIFFERENCES_LABELS = {
  open: msg("Show differences"),
  title: msg("Differences from the other Library"),
  empty: msg("No differences are left from this addition."),
  more: msg("Show more"),
  loading: msg("Reading both Libraries…"),
  here: msg("Here", { $context: "column heading, this Library" }),
  addNote: msg("Add to my note"),
  useNote: msg("Use this note"),
  attach: msg("Attach", { $context: "verb, attach a PDF" }),
  addSeparately: msg("Add separately"),
  removedHere: msg("Removed here, still in the other Library (not brought back)"),
  untitled: msg("Untitled source"),
} as const;

/** The other Library, as a short name for column heads and sentences. */
export function otherLibraryName(
  listed: ScientSourcesJoinDifferences,
  resolve: MessageResolver = m,
): string {
  if (listed.from === "replaced") return resolve(msg("The Library a restore replaced"));
  return listed.backupCreatedAt
    ? resolve(msg("Backup of {day}", { day: dayLabel(listed.backupCreatedAt) }))
    : resolve(msg("The backup"));
}

/** What the list is, and that looking at it changes nothing. */
export function differencesIntro(
  listed: ScientSourcesJoinDifferences,
  resolve: MessageResolver = m,
): string {
  const kind =
    listed.from === "replaced" ? "replaced" : listed.backupCreatedAt ? "dated" : "backup";
  return resolve(
    msg(
      "{kind, select, replaced {These papers of the Library a restore replaced} dated {These papers of the backup of {day}} other {These papers of the backup}} were not added: this Library has them or may have them.",
      { kind, day: listed.backupCreatedAt ? dayLabel(listed.backupCreatedAt) : "" },
    ),
  );
}

/** Said while the folder that was read cannot be read. */
export function differencesAway(
  listed: ScientSourcesJoinDifferences,
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg(
      "The other Library's folder cannot be read now ({folder}). This is what was recorded when the sources were added.",
      { folder: listed.folder },
    ),
  );
}

const titleOf = (title: string | null | undefined, resolve: MessageResolver) =>
  title?.trim() || resolve(JOIN_DIFFERENCES_LABELS.untitled);

/** How the two papers stand to each other, in plain words. */
export function relationLabel(
  row: ScientSourcesJoinDifferenceRow,
  resolve: MessageResolver = m,
): string {
  switch (row.relation) {
    case "same-id":
      return resolve(msg("Saved in both Libraries"));
    case "merged-here":
      return resolve(
        msg("Merged here into “{title}”", { title: titleOf(row.here?.title, resolve) }),
      );
    case "rebuilt-there":
      return resolve(
        msg("The other Library's copy was rebuilt from a project and may lack details"),
      );
    case "rebuilt-here":
      return resolve(msg("The copy here was rebuilt from a project and may lack details"));
    case "same-paper":
      return resolve(msg("The same paper, entered separately in each Library"));
    case "not-here":
      return resolve(msg("No paper here looks like it any more"));
    case "possibly-same":
      return row.candidates.length > 1
        ? resolve(
            msg("May be one of these papers here: {titles}", {
              titles: row.candidates
                .map((candidate) => `“${titleOf(candidate.title, resolve)}”`)
                .join(", "),
            }),
          )
        : resolve(msg("May be the same paper as this one here"));
  }
}

/** The paper's name on its row: this Library's title, or the other's when none here is named. */
export function rowTitle(
  row: ScientSourcesJoinDifferenceRow,
  resolve: MessageResolver = m,
): string {
  return titleOf(row.here?.title ?? row.other?.title ?? row.otherTitle, resolve);
}

const PART_WORDS: Record<ScientSourcesJoinDifferenceRow["parts"][number], string> = {
  details: msg("details", { $context: "a part of a paper that differs" }),
  tags: msg("tags", { $context: "a part of a paper that differs" }),
  note: msg("a note", { $context: "a part of a paper that differs" }),
  reading: msg("read or star", { $context: "a part of a paper that differs" }),
  pdfs: msg("PDFs", { $context: "a part of a paper that differs" }),
  highlights: msg("highlights", { $context: "a part of a paper that differs" }),
};

/** What was recorded as differing, for a row whose other version cannot be read now. */
export function recordedParts(
  row: ScientSourcesJoinDifferenceRow,
  resolve: MessageResolver = m,
): string {
  return row.parts.length > 0
    ? resolve(
        msg("Recorded as differing: {parts}.", {
          parts: row.parts.map((part) => resolve(PART_WORDS[part])).join(", "),
        }),
      )
    : "";
}

/** What an action did not do, as a sentence; null when it was done. */
export function takeProblem(
  outcome: ScientSourcesOrganizeResult["outcome"],
  resolve: MessageResolver = m,
): string | null {
  switch (outcome) {
    case "taken":
    case "take-already":
      return null;
    case "take-changed":
      return resolve(
        msg("One of the two papers changed since this list was shown, so nothing was done."),
      );
    case "take-unavailable":
      return resolve(
        msg(
          "The other Library's folder or that file cannot be read now, or is not the one that was read, so nothing was done.",
        ),
      );
    case "take-too-long":
      return resolve(
        msg(
          "The two notes together are longer than a note can be, so nothing was added. Shorten the note here, or copy the part you want.",
        ),
      );
    default:
      return resolve(msg("Nothing was done."));
  }
}
