import type { ScientSourceDetailResult, ScientSourceRestoreResult } from "@t3tools/contracts";

type EditorialStatus = NonNullable<ScientSourceDetailResult["editorialStatus"]>;
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
    text: `${EDITORIAL_STATE_WORDS[state]}${date ? ` ${notice?.date?.length === 4 ? "in" : "on"} ${date}` : ""}`,
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
  if (verification?.problem === "not-found") return " · Not found in registry";
  if (verification?.problem === "mismatch") return " · Identifier names another work";
  return "";
}
