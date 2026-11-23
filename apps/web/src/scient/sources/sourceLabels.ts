import type { ScientSourceStudyDesign, ScientSourceType } from "@scientfactory/scient-sources";
import type { ScientSourceZoteroRefreshField } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { LIBRARY_LABELS } from "./libraryLabels";

/** A source field's name as a heading or label shows it. */
export const SOURCE_FIELD_LABELS: Readonly<
  Record<ScientSourceZoteroRefreshField, string> & Partial<Record<string, string>>
> = {
  type: msg("Type", { $context: "a source field" }),
  customType: msg("Type", { $context: "a source field" }),
  title: msg("Title", { $context: "a source field" }),
  creators: msg("Creators", { $context: "a source field" }),
  issuedRaw: msg("Date", { $context: "a source field" }),
  issuedYear: msg("Year", { $context: "a source field" }),
  identifiers: msg("Identifiers", { $context: "a source field" }),
  abstract: msg("Abstract", { $context: "a source field" }),
  containerTitle: msg("Journal or publication", { $context: "a source field" }),
  more: msg("More details", { $context: "a source field" }),
  publisher: msg("Publisher", { $context: "a source field" }),
  volume: msg("Volume", { $context: "a source field" }),
  issue: msg("Issue", { $context: "a source field" }),
  pages: msg("Pages", { $context: "a source field" }),
  language: msg("Language", { $context: "a source field" }),
  url: "URL",
  tags: msg("Tags", { $context: "a source field" }),
  note: msg("Note", { $context: "a source field" }),
};

function isSameCalendarDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

type ObservableSourceRecord = {
  readonly sourceId: string;
  readonly importedAt: string;
  /** A pin this Library lacks, such as one whose source is in the Trash: never just added. */
  readonly fromSnapshot?: true;
  readonly origin?:
    | {
        readonly actor?: string;
      }
    | null
    | undefined;
};

export function newlyObservedSourceIds(
  records: ReadonlyArray<ObservableSourceRecord>,
  previousIds: ReadonlySet<string> | null,
  recentCutoff: number,
): ReadonlyArray<string> {
  return records
    .filter((record) => {
      if (record.fromSnapshot) return false;
      if (previousIds) return !previousIds.has(record.sourceId);
      return record.origin?.actor === "agent" && Date.parse(record.importedAt) >= recentCutoff;
    })
    .map((record) => record.sourceId);
}

const VERIFICATION_LABELS = {
  verified: msg("Identifier verified"),
  unchecked: msg("Not yet checked"),
  unverified: msg("No identifier"),
} as const;

export function agentVerificationLabel(
  record: {
    readonly origin?: { readonly actor?: string } | null | undefined;
    readonly verification?:
      | { readonly state: keyof typeof VERIFICATION_LABELS; readonly problem?: string }
      | undefined;
  },
  resolve: MessageResolver = m,
): string {
  // A checked identifier's problem is named by sourceTrustLabel instead.
  if (record.origin?.actor !== "agent" || !record.verification || record.verification.problem) {
    return "";
  }
  return ` · ${resolve(VERIFICATION_LABELS[record.verification.state])}`;
}

/**
 * Where a listed source stands with this project, on a library server only: the Library view
 * marks what is pinned here, and a pin this computer's library lacks says so.
 */
export function sourcePinLabel(
  record: { readonly pinned?: boolean; readonly fromSnapshot?: true },
  listed: "project" | "library" | undefined,
  resolve: MessageResolver = m,
): string {
  if (record.fromSnapshot) return ` · ${resolve(LIBRARY_LABELS.notInThisLibrary)}`;
  return listed === "library" && record.pinned ? ` · ${resolve(LIBRARY_LABELS.inThisProject)}` : "";
}

/** A PDF that names no title is titled by its file name until its details are found. */
export function fileNameTitleLabel(
  record: {
    readonly fieldProvenance?: ReadonlyArray<{
      readonly field: string;
      readonly origin: string;
      readonly sourceField: string | null;
    }>;
  },
  resolve: MessageResolver = m,
): string | null {
  const title = record.fieldProvenance?.findLast((entry) => entry.field === "title");
  return title?.origin === "local-pdf" && title.sourceField === "file-name"
    ? resolve(msg("The title is the file name until this paper's details are found."))
    : null;
}

export function sourceAddedLabel(
  importedAt: string,
  recentlyAdded: boolean,
  addedByAgent = false,
  resolve: MessageResolver = m,
): string {
  if (recentlyAdded) {
    return addedByAgent ? resolve(msg("Just added by an agent")) : resolve(msg("Just added"));
  }
  const date = new Date(importedAt);
  if (Number.isNaN(date.getTime())) return resolve(msg("Added to Scient"));
  if (isSameCalendarDay(date, new Date())) return resolve(msg("Added today"));
  return resolve(
    msg("Added {date}", {
      date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date),
    }),
  );
}

export const SCIENT_SOURCE_STUDY_DESIGN_LABELS = {
  "randomized-trial": msg("Randomized trial"),
  "meta-analysis": msg("Meta-analysis"),
  "systematic-review": msg("Systematic review"),
  cohort: msg("Cohort study"),
  "case-control": msg("Case-control study"),
  "case-report": msg("Case report"),
  review: msg("Review", { $context: "study design" }),
  other: msg("Other design"),
} as const satisfies Readonly<Record<ScientSourceStudyDesign, string>>;

export const SCIENT_SOURCE_TYPE_LABELS = {
  article: msg("Article"),
  preprint: msg("Preprint"),
  book: msg("Book"),
  "book-chapter": msg("Book chapter"),
  "conference-paper": msg("Conference paper"),
  thesis: msg("Thesis"),
  report: msg("Report"),
  dataset: msg("Dataset"),
  web: msg("Web source"),
  software: msg("Software"),
  presentation: msg("Presentation"),
  manuscript: msg("Manuscript"),
  other: msg("Other source"),
} as const satisfies Readonly<Record<ScientSourceType, string>>;
