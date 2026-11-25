import type {
  ScientSourceDetailResult,
  ScientSourceRestoreResult,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

type EditorialStatus = NonNullable<ScientSourceDetailResult["editorialStatus"]>;
type NoticeChange = NonNullable<ScientSourcesOverviewResult["noticeChanges"]>[number];
type Verification = NonNullable<ScientSourceDetailResult["verification"]>;

const FIELD_LABELS: Readonly<Record<string, string>> = {
  type: msg("type", { $context: "a source field named in a sentence" }),
  customType: msg("type", { $context: "a source field named in a sentence" }),
  title: msg("title", { $context: "a source field named in a sentence" }),
  creators: msg("authors", { $context: "a source field named in a sentence" }),
  issuedRaw: msg("date", { $context: "a source field named in a sentence" }),
  issuedYear: msg("date", { $context: "a source field named in a sentence" }),
  identifiers: msg("identifiers", { $context: "a source field named in a sentence" }),
  abstract: msg("abstract", { $context: "a source field named in a sentence" }),
  abstractSections: msg("abstract", { $context: "a source field named in a sentence" }),
  note: msg("note", { $context: "a source field named in a sentence" }),
  containerTitle: msg("journal", { $context: "a source field named in a sentence" }),
  publisher: msg("publisher", { $context: "a source field named in a sentence" }),
  volume: msg("volume", { $context: "a source field named in a sentence" }),
  issue: msg("issue", { $context: "a source field named in a sentence" }),
  pages: msg("pages", { $context: "a source field named in a sentence" }),
  language: msg("language", { $context: "a source field named in a sentence" }),
  url: msg("link", { $context: "a source field named in a sentence" }),
  tags: msg("tags", { $context: "a source field named in a sentence" }),
  more: msg("more details", { $context: "a source field named in a sentence" }),
  attachments: msg("PDFs", { $context: "a source field named in a sentence" }),
  verification: msg("identifier check", { $context: "a source field named in a sentence" }),
  editorialStatus: msg("retraction status", { $context: "a source field named in a sentence" }),
  externalReferences: msg("Zotero link", { $context: "a source field named in a sentence" }),
};

/** What a source's details lack, in plain words ("Not found: date, identifiers"). */
export function missingDetailsLabel(
  fields: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string {
  const labels = [
    ...new Set(
      fields.flatMap((field) => {
        const label = FIELD_LABELS[field];
        return label ? [resolve(label)] : [];
      }),
    ),
  ];
  return labels.length > 0
    ? resolve(msg("Not found: {fields}", { fields: labels.join(", ") }))
    : "";
}

/** Plain names for what a revision changed, without repeats or bookkeeping fields. */
export function changedFieldsLabel(
  changes: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string {
  const labels = [
    ...new Set(
      changes.map((field) => {
        const label = FIELD_LABELS[field];
        return label ? resolve(label) : field;
      }),
    ),
  ];
  if (labels.length === 0) return "";
  const text = labels.join(", ");
  return resolve(msg("Changed {fields}", { fields: text }));
}

export function restoreProblem(
  result: ScientSourceRestoreResult,
  resolve: MessageResolver = m,
): string | null {
  switch (result.outcome) {
    case "restored":
      return null;
    case "not-found":
      return resolve(msg("This source is no longer in the trash."));
    case "exists":
      return resolve(msg("This source is already in the Library."));
    case "duplicate":
      return resolve(
        msg(
          "Another source in the Library has the same identifier. Remove it first to restore this one.",
        ),
      );
  }
}

const EDITORIAL_STATE_WORDS: Readonly<Record<Exclude<EditorialStatus["state"], "none">, string>> = {
  retracted: msg("Retracted", { $context: "editorial status of a paper" }),
  withdrawn: msg("Withdrawn", { $context: "editorial status of a paper" }),
  "expression-of-concern": msg("Expression of concern", {
    $context: "editorial status of a paper",
  }),
  corrected: msg("Corrected", { $context: "editorial status of a paper" }),
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
const carried = (label: string, resolve: MessageResolver) =>
  resolve(msg("{label} (from another computer's check)", { label }));

/** The line shown on a source, or null when the registry reported nothing to warn about. */
export function editorialStatusLine(
  status: EditorialStatus,
  resolve: MessageResolver = m,
): {
  readonly text: string;
  readonly serious: boolean;
  readonly noticeDoi: string | null;
} | null {
  const state = status.state;
  if (state === "none") return null;
  const notice = status.notices.find((entry) => entry.kind === NOTICE_FOR_STATE[state]);
  const date = noticeDate(notice?.date);
  const word = resolve(EDITORIAL_STATE_WORDS[state]);
  const dated = !date
    ? word
    : notice?.date?.length === 4
      ? resolve(msg("{state} in {year}", { state: word, year: date }))
      : resolve(msg("{state} on {date}", { state: word, date }));
  return {
    text: status.carriedAt ? carried(dated, resolve) : dated,
    serious: state === "retracted" || state === "withdrawn",
    noticeDoi: notice?.doi ?? null,
  };
}

/** A short row label for what the registry said about a source, or "" when nothing is wrong. */
export function sourceTrustLabel(
  record: {
    readonly editorialStatus?: EditorialStatus | undefined;
    readonly verification?: Verification | undefined;
  },
  resolve: MessageResolver = m,
): string {
  const editorial = record.editorialStatus?.state;
  if (editorial && editorial !== "none") return ` · ${resolve(EDITORIAL_STATE_WORDS[editorial])}`;
  return verificationProblemLabel(record.verification, resolve);
}

export function verificationProblemLabel(
  verification: Verification | undefined,
  resolve: MessageResolver = m,
): string {
  const problem =
    verification?.problem === "not-found"
      ? resolve(msg("Not found in registry"))
      : verification?.problem === "mismatch"
        ? resolve(msg("Identifier names another work"))
        : null;
  if (problem === null) return "";
  return ` · ${verification?.carriedAt ? carried(problem, resolve) : problem}`;
}

/** Above the list narrowed to the papers of the weekly check's line. */
export const NOTICE_CHANGES_SHOWN = msg("Found by the weekly check");

const NOTICE_CHANGE_WORDS = [
  [
    "retraction",
    msg("{count, plural, one {{count} paper was retracted} other {{count} papers were retracted}}"),
  ],
  [
    "expression-of-concern",
    msg(
      "{count, plural, one {{count} paper was flagged with an expression of concern} other {{count} papers were flagged with an expression of concern}}",
    ),
  ],
  [
    "correction",
    msg("{count, plural, one {{count} paper was corrected} other {{count} papers were corrected}}"),
  ],
  [
    "withdrawn",
    msg(
      "{count, plural, one {{count} paper was reinstated} other {{count} papers were reinstated}}",
    ),
  ],
] as const;

/** What the weekly check found, each paper counted once under its most serious new notice. */
export function noticeChangesLine(
  changes: ReadonlyArray<NoticeChange>,
  resolve: MessageResolver = m,
): string | null {
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
  const parts = NOTICE_CHANGE_WORDS.flatMap(([kind, words]) => {
    const count = counted.get(kind) ?? 0;
    return count === 0 ? [] : [resolve(words, { count })];
  });
  return parts.length > 0
    ? resolve(msg("The weekly check found: {findings}.", { findings: parts.join(", ") }))
    : null;
}
