import type { ScientSourceStudyDesign, ScientSourceType } from "@scientfactory/scient-sources";

import { LIBRARY_LABELS } from "./libraryLabels";

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
  verified: "Identifier verified",
  unchecked: "Not yet checked",
  unverified: "No identifier",
} as const;

export function agentVerificationLabel(record: {
  readonly origin?: { readonly actor?: string } | null | undefined;
  readonly verification?:
    | { readonly state: keyof typeof VERIFICATION_LABELS; readonly problem?: string }
    | undefined;
}): string {
  // A checked identifier's problem is named by sourceTrustLabel instead.
  if (record.origin?.actor !== "agent" || !record.verification || record.verification.problem) {
    return "";
  }
  return ` · ${VERIFICATION_LABELS[record.verification.state]}`;
}

/**
 * Where a listed source stands with this project, on a library server only: the Library view
 * marks what is pinned here, and a pin this computer's library lacks says so.
 */
export function sourcePinLabel(
  record: { readonly pinned?: boolean; readonly fromSnapshot?: true },
  listed: "project" | "library" | undefined,
): string {
  if (record.fromSnapshot) return ` · ${LIBRARY_LABELS.notInThisLibrary}`;
  return listed === "library" && record.pinned ? ` · ${LIBRARY_LABELS.inThisProject}` : "";
}

/** A PDF that names no title is titled by its file name until its details are found. */
export function fileNameTitleLabel(record: {
  readonly fieldProvenance?: ReadonlyArray<{
    readonly field: string;
    readonly origin: string;
    readonly sourceField: string | null;
  }>;
}): string | null {
  const title = record.fieldProvenance?.findLast((entry) => entry.field === "title");
  return title?.origin === "local-pdf" && title.sourceField === "file-name"
    ? "The title is the file name until this paper's details are found."
    : null;
}

export function sourceAddedLabel(
  importedAt: string,
  recentlyAdded: boolean,
  addedByAgent = false,
): string {
  if (recentlyAdded) return addedByAgent ? "Just added by an agent" : "Just added";
  const date = new Date(importedAt);
  if (Number.isNaN(date.getTime())) return "Added to Scient";
  if (isSameCalendarDay(date, new Date())) return "Added today";
  return `Added ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}`;
}

export const SCIENT_SOURCE_STUDY_DESIGN_LABELS = {
  "randomized-trial": "Randomized trial",
  "meta-analysis": "Meta-analysis",
  "systematic-review": "Systematic review",
  cohort: "Cohort study",
  "case-control": "Case-control study",
  "case-report": "Case report",
  review: "Review",
  other: "Other design",
} as const satisfies Readonly<Record<ScientSourceStudyDesign, string>>;

export const SCIENT_SOURCE_TYPE_LABELS = {
  article: "Article",
  preprint: "Preprint",
  book: "Book",
  "book-chapter": "Book chapter",
  "conference-paper": "Conference paper",
  thesis: "Thesis",
  report: "Report",
  dataset: "Dataset",
  web: "Web source",
  other: "Other source",
} as const satisfies Readonly<Record<ScientSourceType, string>>;
