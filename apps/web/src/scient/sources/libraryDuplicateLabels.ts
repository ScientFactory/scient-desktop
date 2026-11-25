import type {
  ScientSourcesDuplicateReason,
  ScientSourcesMergeUndoState,
  ScientSourcesDuplicateSource,
  ScientSourcesDuplicatesResult,
  ScientSourcesOrganizeResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { dayLabel } from "./dayLabel";

/**
 * Words of the possible-duplicates screen. `libraryDuplicateLabels.test.ts` keeps the engine's
 * words ("pin", "alias", "survivor", "loser", "record") out of every one of them.
 */
export const DUPLICATE_LABELS = {
  menuItem: msg("Possible duplicates"),
  title: msg("Possible duplicates"),
  pairsSection: msg("Possible duplicates"),
  mergedSection: msg("Merged", { $context: "section heading, sources merged earlier" }),
  noPairs: msg("No possible duplicates in your Library."),
  noMerges: msg("No merges that can be undone."),
  noMergesAtAll: msg("No merges yet."),
  canUndo: msg("Can undo", { $context: "filter, merges that can be undone" }),
  allMerges: msg("All", { $context: "filter, every merge" }),
  undoneState: msg("Undone", { $context: "state of a merge that was undone" }),
  loadFailed: msg("Possible duplicates could not be loaded"),
  tryAgain: msg("Try again"),
  merge: msg("Merge", { $context: "verb, button" }),
  notDuplicates: msg("Not duplicates"),
  undo: msg("Undo", { $context: "verb, button" }),
  review: msg("Review", { $context: "verb, button" }),
  keepThis: msg("Keep this one"),
  suggested: msg("Suggested", { $context: "the copy suggested to keep" }),
  mergeFailed: msg("The sources were not merged"),
  notDuplicatesFailed: msg("The sources were not marked"),
  oneGone: msg("One of them is no longer in the Library."),
  undoFailed: msg("The merge was not undone"),
  markedNotDuplicates: msg("Marked as not duplicates"),
  markedHelp: msg("They are not listed here again."),
  unmarked: msg("Listed as possible duplicates again"),
  mergeUndone: msg("Merge undone"),
  inThisProject: msg("In this project"),
  notInThisProject: msg("Not in this project"),
  hasPdf: msg("Has a PDF"),
  noPdf: msg("No PDF"),
  untitled: msg("Untitled"),
  automatic: msg("Merged automatically when the Library moved"),
  requested: msg("Merged on request"),
  keptSide: msg("Kept", { $context: "the copy a merge kept" }),
  mergedSide: msg("Merged away", { $context: "the copy a merge removed" }),
  none: msg("none", { $context: "no value for a field" }),
  showMore: msg("Show more"),
  restarted: msg("The list changed, so it starts again from the top."),
} as const;

/** How a merge's different-value fields read in a sentence. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  type: msg("type", { $context: "a source field named in a sentence" }),
  customType: msg("type", { $context: "a source field named in a sentence" }),
  title: msg("title", { $context: "a source field named in a sentence" }),
  creators: msg("authors", { $context: "a source field named in a sentence" }),
  issuedRaw: msg("date", { $context: "a source field named in a sentence" }),
  issuedYear: msg("year", { $context: "a source field named in a sentence" }),
  abstract: msg("abstract", { $context: "a source field named in a sentence" }),
  abstractSections: msg("abstract", { $context: "a source field named in a sentence" }),
  containerTitle: msg("journal", { $context: "a source field named in a sentence" }),
  publisher: msg("publisher", { $context: "a source field named in a sentence" }),
  volume: msg("volume", { $context: "a source field named in a sentence" }),
  issue: msg("issue", { $context: "a source field named in a sentence" }),
  pages: msg("pages", { $context: "a source field named in a sentence" }),
  language: msg("language", { $context: "a source field named in a sentence" }),
  url: msg("web address", { $context: "a source field named in a sentence" }),
  more: msg("more details", { $context: "a source field named in a sentence" }),
  identifiers: msg("identifiers", { $context: "a source field named in a sentence" }),
  attachments: msg("PDF", { $context: "a source field named in a sentence" }),
  note: msg("note", { $context: "a source field named in a sentence" }),
  readingStatus: msg("reading state", { $context: "a source field named in a sentence" }),
  starred: msg("star", { $context: "a source field named in a sentence" }),
  citationKey: msg("citation key", { $context: "a source field named in a sentence" }),
  verification: msg("registry check", { $context: "a source field named in a sentence" }),
  editorialStatus: msg("editorial notices", { $context: "a source field named in a sentence" }),
};

function joinWords(words: ReadonlyArray<string>, resolve: MessageResolver): string {
  if (words.length <= 1) return words.join("");
  return resolve(
    msg("{items} and {last}", { items: words.slice(0, -1).join(", "), last: words.at(-1)! }),
  );
}

function fieldWords(fields: ReadonlyArray<string>, resolve: MessageResolver): string {
  return joinWords(
    [
      ...new Set(
        fields.map((field) => {
          const word = FIELD_WORDS[field];
          return word ? resolve(word) : resolve(msg("other details"));
        }),
      ),
    ],
    resolve,
  );
}

const quoted = (title: string | null, resolve: MessageResolver) =>
  resolve(msg("“{title}”", { title: title ?? resolve(DUPLICATE_LABELS.untitled) }));

const capitalized = (text: string) => `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`;

export function mergedTitleLabel(keptTitle: string | null, resolve: MessageResolver = m): string {
  return resolve(msg("Merged into {title}", { title: quoted(keptTitle, resolve) }));
}

/** The toast's second sentence; null when the two had no different values. */
export function keptDifferentLabel(
  fields: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string | null {
  return fields.length === 0
    ? null
    : resolve(
        msg("Where they differed, the kept one's {fields} stayed.", {
          fields: fieldWords(fields, resolve),
        }),
      );
}

type MergeDifference = ScientSourcesDuplicatesResult["merges"][number]["differences"][number];
type MergeValues = Extract<MergeDifference, { readonly kept: unknown }>;

/** A field the merge file holds both values of; identifiers and PDFs are only named. */
export const hasMergeValues = (difference: MergeDifference): difference is MergeValues =>
  "kept" in difference;

/**
 * `kept` is null once the kept source was merged again or moved to the Trash. Two copies with one
 * title are told apart by what differed: values the kept one kept, and ones it took from the other.
 */
export function mergedRowLabel(
  merge: {
    readonly mergedTitle: string | null;
    readonly kept: { readonly title: string | null } | null;
    readonly differences: ReadonlyArray<Pick<MergeDifference, "field">>;
  },
  resolve: MessageResolver = m,
): string {
  const { mergedTitle, kept } = merge;
  const merged = quoted(mergedTitle, resolve);
  if (!kept) {
    return resolve(msg("{merged} merged into a source no longer in your Library", { merged }));
  }
  if (kept.title !== mergedTitle) {
    return resolve(
      msg("{merged} merged into {kept}", { merged, kept: quoted(kept.title, resolve) }),
    );
  }
  return merge.differences.length > 0
    ? resolve(
        msg("Two copies of {merged} merged. Their {fields} differed.", {
          merged,
          fields: fieldWords(
            merge.differences.map(({ field }) => field),
            resolve,
          ),
        }),
      )
    : resolve(msg("Two copies of {merged} merged", { merged }));
}

/**
 * The fields named without values ("Identifiers and PDF differed."), for a row whose first line
 * does not already name what differed: two titles, or a kept source no longer in the Library.
 */
export function namedDifferencesLabel(
  differences: ReadonlyArray<MergeDifference>,
  resolve: MessageResolver = m,
): string | null {
  const fields = differences.filter((difference) => !hasMergeValues(difference));
  if (fields.length === 0) return null;
  const words = fieldWords(
    fields.map(({ field }) => field),
    resolve,
  );
  return resolve(msg("{fields} differed.", { fields: capitalized(words) }));
}

/** One field the two differed in, with both values: "Volume: none (kept), 12 (merged away)". */
export function mergeDifferenceLabel(
  difference: MergeValues,
  resolve: MessageResolver = m,
): string {
  const word = fieldWords([difference.field], resolve);
  const value = (text: string | null) => text ?? resolve(DUPLICATE_LABELS.none);
  return resolve(
    msg("{field}: {kept} (kept), {other} (merged away)", {
      field: capitalized(word),
      kept: value(difference.kept),
      other: value(difference.other),
    }),
  );
}

const SUMMARY_FIELDS: ReadonlyArray<DuplicateField> = ["authors", "year", "journal", "identifiers"];

/** One line that tells two copies apart; `projects` adds where the source is used. */
export function sideSummary(
  source: ScientSourcesDuplicateSource,
  options: { readonly projects: boolean },
  resolve: MessageResolver = m,
): string {
  return [...SUMMARY_FIELDS, ...(options.projects ? (["projects"] as const) : [])]
    .map((field) => fieldValue(source, field, resolve))
    .filter(Boolean)
    .join(" · ");
}

/** The month-name date the details and History use ("Nov 12, 2026"). */
export function mergedDateLabel(mergedAt: string): string {
  return Number.isNaN(new Date(mergedAt).getTime()) ? "" : dayLabel(mergedAt);
}

export function sectionCountLabel(label: string, count: number): string {
  return count > 0 ? `${label} (${count.toLocaleString()})` : label;
}

export function shownOfTotalLabel(
  shown: number,
  total: number,
  resolve: MessageResolver = m,
): string | null {
  return total > shown
    ? resolve(
        msg("Showing {shown} of {total}.", {
          shown: shown.toLocaleString(),
          total: total.toLocaleString(),
        }),
      )
    : null;
}

const MATCH_WORDS: Readonly<Record<string, string>> = {
  "possible-item-match": msg("Same Zotero item"),
  "possible-identifier-match": msg("Same identifier"),
  "possible-pdf-match": msg("Same PDF"),
  "possible-version-match": msg("Same title and first author"),
};

const REASON_WORDS: Readonly<Record<ScientSourcesDuplicateReason, string>> = {
  "merge-undone": msg("but their merge was undone", {
    $context: "after a match reason, why it was not merged",
  }),
  "merge-record-unreadable": msg("but the details of an earlier merge of one could not be read", {
    $context: "after a match reason, why it was not merged",
  }),
  "title-missing": msg("but one has no title", {
    $context: "after a match reason, why it was not merged",
  }),
  "titles-differ": msg("but the titles differ", {
    $context: "after a match reason, why it was not merged",
  }),
  "type-unknown": msg("but one has no known type", {
    $context: "after a match reason, why it was not merged",
  }),
  "preprint-and-published": msg("but one is a preprint and the other published", {
    $context: "after a match reason, why it was not merged",
  }),
  "types-differ": msg("but the types differ", {
    $context: "after a match reason, why it was not merged",
  }),
  "arxiv-versions-differ": msg("but different arXiv versions", {
    $context: "after a match reason, why it was not merged",
  }),
  "identifiers-conflict": msg("but other identifiers differ", {
    $context: "after a match reason, why it was not merged",
  }),
  "conflicting-group": msg("but it also links copies that disagree", {
    $context: "after a match reason, why it was not merged",
  }),
};

/** Why Scient did not merge a pair that shares an item, identifier or PDF; null for the others. */
export function pairReasonLabel(
  pair: {
    readonly kind: string;
    readonly reason?: ScientSourcesDuplicateReason;
  },
  resolve: MessageResolver = m,
): string | null {
  const match = MATCH_WORDS[pair.kind];
  return match && pair.reason
    ? resolve(
        msg("{match}, {reason}.", {
          match: resolve(match),
          reason: resolve(REASON_WORDS[pair.reason]),
        }),
      )
    : null;
}

export function otherProjectsLabel(
  names: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string | null {
  return names.length === 0
    ? null
    : resolve(msg("Also in {projects}", { projects: joinWords(names, resolve) }));
}

/** What the pair's two sides differ in, in the order the rows show them. */
export function differingFields(
  left: ScientSourcesDuplicateSource,
  right: ScientSourcesDuplicateSource,
): ReadonlyArray<DuplicateField> {
  return DUPLICATE_FIELDS.filter((field) => fieldValue(left, field) !== fieldValue(right, field));
}

export const DUPLICATE_FIELDS = [
  "title",
  "authors",
  "year",
  "journal",
  "identifiers",
  "pdf",
  "projects",
] as const;
export type DuplicateField = (typeof DUPLICATE_FIELDS)[number];

const DIFFERS_WORDS: Record<DuplicateField, string> = {
  title: msg("title", { $context: "a source field named in a sentence" }),
  authors: msg("authors", { $context: "a source field named in a sentence" }),
  year: msg("year", { $context: "a source field named in a sentence" }),
  journal: msg("journal", { $context: "a source field named in a sentence" }),
  identifiers: msg("identifiers", { $context: "a source field named in a sentence" }),
  pdf: msg("PDF", { $context: "a source field named in a sentence" }),
  projects: msg("projects", { $context: "a source field named in a sentence" }),
};

export function differsLabel(
  fields: ReadonlyArray<DuplicateField>,
  resolve: MessageResolver = m,
): string {
  return fields.length === 0
    ? resolve(msg("Same details."))
    : resolve(
        msg("Different {fields}.", {
          fields: joinWords(
            fields.map((field) => resolve(DIFFERS_WORDS[field])),
            resolve,
          ),
        }),
      );
}

const authorName = (creator: ScientSourcesDuplicateSource["creators"][number]) =>
  creator.literalName ?? [creator.givenName, creator.familyName].filter(Boolean).join(" ").trim();

/** The text a row shows for one field; equal text on both sides means "same". */
export function fieldValue(
  source: ScientSourcesDuplicateSource,
  field: DuplicateField,
  resolve: MessageResolver = m,
): string {
  switch (field) {
    case "title":
      return source.title ?? resolve(DUPLICATE_LABELS.untitled);
    case "authors":
      return source.creators.map(authorName).filter(Boolean).join(", ");
    case "year":
      return source.issuedYear === null ? "" : String(source.issuedYear);
    case "journal":
      return source.containerTitle ?? "";
    case "identifiers":
      return source.identifiers
        .map((identifier) => `${identifier.scheme.toUpperCase()} ${identifier.value}`)
        .join(", ");
    case "pdf":
      return source.attachments.some((attachment) => attachment.kind === "pdf")
        ? resolve(DUPLICATE_LABELS.hasPdf)
        : resolve(DUPLICATE_LABELS.noPdf);
    case "projects":
      return [
        source.pinned
          ? resolve(DUPLICATE_LABELS.inThisProject)
          : resolve(DUPLICATE_LABELS.notInThisProject),
        otherProjectsLabel(source.otherProjects, resolve),
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

/** What an Undo answer means, or null when it undid the merge. */
export function undoProblem(
  result: ScientSourcesOrganizeResult,
  resolve: MessageResolver = m,
): string | null {
  switch (result.outcome) {
    case "undone":
      return null;
    case "already-undone":
      return resolve(msg("This merge was already undone."));
    case "survivor-missing":
      return resolve(
        msg("The kept source was merged again or moved to the Trash since. Undo that first."),
      );
    case "loser-missing":
      return resolve(msg("The other source is no longer in the Trash, so it cannot come back."));
    default:
      return resolve(msg("This merge is no longer listed."));
  }
}

/** The sentence after Undo, when edits made after the merge were kept. */
export function unrevertedLabel(
  fields: ReadonlyArray<string> | undefined,
  resolve: MessageResolver = m,
): string | null {
  return fields && fields.length > 0
    ? resolve(
        msg("Changes made after the merge were kept: {fields}.", {
          fields: fieldWords(fields, resolve),
        }),
      )
    : null;
}

/** Why a merge in the full list has no Undo; null when Undo can run. */
export function mergeStateLabel(
  undo: ScientSourcesMergeUndoState,
  resolve: MessageResolver = m,
): string | null {
  switch (undo) {
    case "available":
      return null;
    case "undone":
      return resolve(DUPLICATE_LABELS.undoneState);
    case "kept-source-gone":
      return resolve(
        msg("Can no longer be undone: the kept source was merged again or moved to the Trash."),
      );
    case "merged-source-gone":
      return resolve(msg("Can no longer be undone: the merged-away source left the Trash."));
  }
}

/** Merge files hold the Undo decisions, so one Scient cannot read is said plainly. */
export function damagedReceiptsLabel(count: number, resolve: MessageResolver = m): string | null {
  if (count === 0) return null;
  return count === 1
    ? resolve(
        msg(
          "The details of one merge could not be read. The sources it names are not merged automatically until its file is repaired.",
        ),
      )
    : resolve(
        msg(
          "The details of {count} merges could not be read. The sources they name are not merged automatically until their files are repaired.",
          { count },
        ),
      );
}
