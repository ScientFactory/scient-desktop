import type { ScientSourceRestoreResult } from "@t3tools/contracts";

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
