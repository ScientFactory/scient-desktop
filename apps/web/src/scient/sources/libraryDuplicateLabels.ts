import type {
  ScientSourcesDuplicateSource,
  ScientSourcesDuplicatesResult,
  ScientSourcesOrganizeResult,
} from "@t3tools/contracts";

/**
 * Words of the possible-duplicates screen. `libraryDuplicateLabels.test.ts` keeps the engine's
 * words ("pin", "alias", "survivor", "loser", "record") out of every one of them.
 */
export const DUPLICATE_LABELS = {
  menuItem: "Possible duplicates",
  title: "Possible duplicates",
  pairsSection: "Possible duplicates",
  mergedSection: "Merged",
  noPairs: "No possible duplicates in your Library.",
  noMerges: "No merges that can be undone.",
  loadFailed: "Possible duplicates could not be loaded",
  tryAgain: "Try again",
  merge: "Merge",
  notDuplicates: "Not duplicates",
  undo: "Undo",
  review: "Review",
  keepThis: "Keep this one",
  suggested: "Suggested",
  mergeFailed: "The sources were not merged",
  notDuplicatesFailed: "The sources were not marked",
  oneGone: "One of them is no longer in the Library.",
  undoFailed: "The merge was not undone",
  markedNotDuplicates: "Marked as not duplicates",
  markedHelp: "They are not listed here again.",
  unmarked: "Listed as possible duplicates again",
  mergeUndone: "Merge undone",
  inThisProject: "In this project",
  notInThisProject: "Not in this project",
  hasPdf: "Has a PDF",
  noPdf: "No PDF",
  untitled: "Untitled",
  automatic: "Merged automatically when the Library moved",
  requested: "Merged on request",
  keptSide: "Kept",
  mergedSide: "Merged away",
  none: "none",
} as const;

/** How a merge's different-value fields read in a sentence. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  type: "type",
  customType: "type",
  title: "title",
  creators: "authors",
  issuedRaw: "date",
  issuedYear: "year",
  abstract: "abstract",
  abstractSections: "abstract",
  containerTitle: "journal",
  publisher: "publisher",
  volume: "volume",
  issue: "issue",
  pages: "pages",
  language: "language",
  url: "web address",
  identifiers: "identifiers",
  attachments: "PDF",
  note: "note",
  readingStatus: "reading state",
  starred: "star",
  citationKey: "citation key",
  verification: "registry check",
  editorialStatus: "editorial notices",
};

function joinWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function fieldWords(fields: ReadonlyArray<string>): string {
  return joinWords([...new Set(fields.map((field) => FIELD_WORDS[field] ?? "other details"))]);
}

const quoted = (title: string | null) => `“${title ?? DUPLICATE_LABELS.untitled}”`;

export function mergedTitleLabel(keptTitle: string | null): string {
  return `Merged into ${quoted(keptTitle)}`;
}

/** The toast's second sentence; null when the two had no different values. */
export function keptDifferentLabel(fields: ReadonlyArray<string>): string | null {
  return fields.length === 0
    ? null
    : `Where they differed, the kept one's ${fieldWords(fields)} stayed.`;
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
export function mergedRowLabel(merge: {
  readonly mergedTitle: string | null;
  readonly kept: { readonly title: string | null } | null;
  readonly differences: ReadonlyArray<Pick<MergeDifference, "field">>;
}): string {
  const { mergedTitle, kept } = merge;
  if (!kept) return `${quoted(mergedTitle)} merged into a source no longer in your Library`;
  if (kept.title !== mergedTitle) return `${quoted(mergedTitle)} merged into ${quoted(kept.title)}`;
  return merge.differences.length > 0
    ? `Two copies of ${quoted(mergedTitle)} merged. Their ${fieldWords(merge.differences.map(({ field }) => field))} differed.`
    : `Two copies of ${quoted(mergedTitle)} merged`;
}

/** One field the two differed in, with both values: "Volume: none (kept), 12 (merged away)". */
export function mergeDifferenceLabel(difference: MergeValues): string {
  const word = fieldWords([difference.field]);
  const value = (text: string | null) => text ?? DUPLICATE_LABELS.none;
  return `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}: ${value(difference.kept)} (kept), ${value(difference.other)} (merged away)`;
}

const SUMMARY_FIELDS: ReadonlyArray<DuplicateField> = ["authors", "year", "journal", "identifiers"];

/** One line that tells two copies apart; `projects` adds where the source is used. */
export function sideSummary(
  source: ScientSourcesDuplicateSource,
  options: { readonly projects: boolean },
): string {
  return [...SUMMARY_FIELDS, ...(options.projects ? (["projects"] as const) : [])]
    .map((field) => fieldValue(source, field))
    .filter(Boolean)
    .join(" · ");
}

/** The month-name date the details and History use ("Nov 12, 2026"). */
export function mergedDateLabel(mergedAt: string): string {
  const date = new Date(mergedAt);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function sectionCountLabel(label: string, count: number): string {
  return count > 0 ? `${label} (${count.toLocaleString()})` : label;
}

export function shownOfTotalLabel(shown: number, total: number): string | null {
  return total > shown
    ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}. Settle these to see the rest.`
    : null;
}

export function otherProjectsLabel(names: ReadonlyArray<string>): string | null {
  return names.length === 0 ? null : `Also in ${joinWords(names)}`;
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

export function differsLabel(fields: ReadonlyArray<DuplicateField>): string {
  const words: Record<DuplicateField, string> = {
    title: "title",
    authors: "authors",
    year: "year",
    journal: "journal",
    identifiers: "identifiers",
    pdf: "PDF",
    projects: "projects",
  };
  return fields.length === 0
    ? "Same details."
    : `Different ${joinWords(fields.map((field) => words[field]))}.`;
}

const authorName = (creator: ScientSourcesDuplicateSource["creators"][number]) =>
  creator.literalName ?? [creator.givenName, creator.familyName].filter(Boolean).join(" ").trim();

/** The text a row shows for one field; equal text on both sides means "same". */
export function fieldValue(source: ScientSourcesDuplicateSource, field: DuplicateField): string {
  switch (field) {
    case "title":
      return source.title ?? DUPLICATE_LABELS.untitled;
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
        ? DUPLICATE_LABELS.hasPdf
        : DUPLICATE_LABELS.noPdf;
    case "projects":
      return [
        source.pinned ? DUPLICATE_LABELS.inThisProject : DUPLICATE_LABELS.notInThisProject,
        otherProjectsLabel(source.otherProjects),
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

/** What an Undo answer means, or null when it undid the merge. */
export function undoProblem(result: ScientSourcesOrganizeResult): string | null {
  switch (result.outcome) {
    case "undone":
      return null;
    case "already-undone":
      return "This merge was already undone.";
    case "survivor-missing":
      return "The kept source was merged again or moved to the Trash since. Undo that first.";
    case "loser-missing":
      return "The other source is no longer in the Trash, so it cannot come back.";
    default:
      return "This merge is no longer listed.";
  }
}

/** The sentence after Undo, when edits made after the merge were kept. */
export function unrevertedLabel(fields: ReadonlyArray<string> | undefined): string | null {
  return fields && fields.length > 0
    ? `Changes made after the merge were kept: ${fieldWords(fields)}.`
    : null;
}
