import type {
  ScientSourceDetailResult,
  ScientSourceRestoreResult,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";

type EditorialStatus = NonNullable<ScientSourceDetailResult["editorialStatus"]>;
type NoticeChange = NonNullable<ScientSourcesOverviewResult["noticeChanges"]>[number];
type Verification = NonNullable<ScientSourceDetailResult["verification"]>;

const FIELD_LABELS: Readonly<Record<string, string>> = {
  type: "type",
  customType: "type",
  title: "title",
  creators: "authors",
  issuedRaw: "date",
  issuedYear: "date",
  identifiers: "identifiers",
  abstract: "abstract",
  abstractSections: "abstract",
  note: "note",
  containerTitle: "journal",
  publisher: "publisher",
  volume: "volume",
  issue: "issue",
  pages: "pages",
  language: "language",
  url: "link",
  tags: "tags",
  more: "more details",
  attachments: "PDFs",
  verification: "identifier check",
  editorialStatus: "retraction status",
  externalReferences: "Zotero link",
};

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

const byLabel = (actor: "user" | "agent") => (actor === "agent" ? "by an agent" : "by you");

export function removedLabel(entry: {
  readonly removedAt: string;
  readonly removedBy: "user" | "agent";
}): string {
  const date = shortDate(entry.removedAt);
  return `Removed ${byLabel(entry.removedBy)}${date ? ` · ${date}` : ""}`;
}

export function revisionLabel(revision: {
  readonly savedAt: string;
  readonly savedBy: "user" | "agent";
  readonly changes: ReadonlyArray<string>;
}): string {
  const date = shortDate(revision.savedAt);
  const verb = revision.changes.length === 0 ? "Saved" : "Edited";
  return `${verb} ${byLabel(revision.savedBy)}${date ? ` · ${date}` : ""}`;
}

/** Plain names for what a revision changed, without repeats or bookkeeping fields. */
export function changedFieldsLabel(changes: ReadonlyArray<string>): string {
  const labels = [...new Set(changes.map((field) => FIELD_LABELS[field] ?? field))];
  if (labels.length === 0) return "";
  const text = labels.join(", ");
  return `Changed ${text}`;
}

export function restoreProblem(result: ScientSourceRestoreResult): string | null {
  switch (result.outcome) {
    case "restored":
      return null;
    case "not-found":
      return "This source is no longer in the trash.";
    case "exists":
      return "This source is already in the Library.";
    case "duplicate":
      return "Another source in the Library has the same identifier. Remove it first to restore this one.";
  }
}

const EDITORIAL_STATE_WORDS: Readonly<Record<Exclude<EditorialStatus["state"], "none">, string>> = {
  retracted: "Retracted",
  withdrawn: "Withdrawn",
  "expression-of-concern": "Expression of concern",
  corrected: "Corrected",
};

const NOTICE_FOR_STATE = {
  retracted: "retraction",
  withdrawn: "withdrawal",
  "expression-of-concern": "expression-of-concern",
  corrected: "correction",
} as const;

function noticeDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(`${value.length === 4 ? `${value}-01-01` : value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    ...(value.length === 4 ? { year: "numeric" } : { dateStyle: "medium" }),
    timeZone: "UTC",
  }).format(date);
}

/** Evidence a project package brought: another computer's check, never one made here. */
const CARRIED = " (from another computer's check)";

/** The line shown on a source, or null when the registry reported nothing to warn about. */
export function editorialStatusLine(status: EditorialStatus): {
  readonly text: string;
  readonly serious: boolean;
  readonly noticeDoi: string | null;
} | null {
  const state = status.state;
  if (state === "none") return null;
  const notice = status.notices.find((entry) => entry.kind === NOTICE_FOR_STATE[state]);
  const date = noticeDate(notice?.date);
  return {
    text: `${EDITORIAL_STATE_WORDS[state]}${date ? ` ${notice?.date?.length === 4 ? "in" : "on"} ${date}` : ""}${status.carriedAt ? CARRIED : ""}`,
    serious: state === "retracted" || state === "withdrawn",
    noticeDoi: notice?.doi ?? null,
  };
}

/** A short row label for what the registry said about a source, or "" when nothing is wrong. */
export function sourceTrustLabel(record: {
  readonly editorialStatus?: EditorialStatus | undefined;
  readonly verification?: Verification | undefined;
}): string {
  const editorial = record.editorialStatus?.state;
  if (editorial && editorial !== "none") return ` · ${EDITORIAL_STATE_WORDS[editorial]}`;
  return verificationProblemLabel(record.verification);
}

export function verificationProblemLabel(verification: Verification | undefined): string {
  const carried = verification?.carriedAt ? CARRIED : "";
  if (verification?.problem === "not-found") return ` · Not found in registry${carried}`;
  if (verification?.problem === "mismatch") return ` · Identifier names another work${carried}`;
  return "";
}

/** Above the list narrowed to the papers of the weekly check's line. */
export const NOTICE_CHANGES_SHOWN = "Found by the weekly check";

const NOTICE_CHANGE_WORDS = [
  ["retraction", "was retracted", "were retracted"],
  [
    "expression-of-concern",
    "was flagged with an expression of concern",
    "were flagged with an expression of concern",
  ],
  ["correction", "was corrected", "were corrected"],
  ["withdrawn", "had a notice taken back", "had a notice taken back"],
] as const;

/** What the weekly check found, each paper counted once under its most serious new notice. */
export function noticeChangesLine(changes: ReadonlyArray<NoticeChange>): string | null {
  const found = new Map<string, Set<string>>();
  for (const change of changes) {
    const kinds = found.get(change.sourceId) ?? new Set();
    kinds.add(change.change === "added" ? change.kind : "withdrawn");
    found.set(change.sourceId, kinds);
  }
  const counted = new Map<string, number>();
  for (const kinds of found.values()) {
    const first = NOTICE_CHANGE_WORDS.find(([kind]) => kinds.has(kind))?.[0];
    if (first) counted.set(first, (counted.get(first) ?? 0) + 1);
  }
  const parts = NOTICE_CHANGE_WORDS.flatMap(([kind, one, many]) => {
    const count = counted.get(kind) ?? 0;
    return count === 0 ? [] : [count === 1 ? `1 paper ${one}` : `${count} papers ${many}`];
  });
  return parts.length > 0 ? `The weekly check found: ${parts.join(", ")}.` : null;
}
