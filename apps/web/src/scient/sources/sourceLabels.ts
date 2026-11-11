import type { ScientSourceType } from "@scientfactory/scient-sources";

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
