import type { ScientSourceCreator, ScientSourceIdentifier, ScientSourceRecord } from "./model.ts";

/**
 * The citation inputs a pin snapshot carries beyond its first six fields: what the bibliography
 * and citation formatter read. A snapshot written before them lacks the keys: unknown, not empty.
 */
export const SCIENT_PIN_CITATION_TEXT_FIELDS = [
  "customType",
  "issuedRaw",
  "publisher",
  "volume",
  "issue",
  "pages",
  "language",
  "url",
] as const;

type CitationTextField = (typeof SCIENT_PIN_CITATION_TEXT_FIELDS)[number];

/** A pin's snapshot fields as the formatter reads them; the optional ones may be unknown. */
export type ScientPinCitationWork = {
  readonly type: string;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedYear: number | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly containerTitle: string | null;
  readonly tags?: ReadonlyArray<string>;
} & { readonly [Field in CitationTextField]?: string | null };

/** Whether the snapshot knows every citation input, as one written by this version does. */
export function scientPinWorkIsComplete(work: ScientPinCitationWork): boolean {
  return work.tags !== undefined && SCIENT_PIN_CITATION_TEXT_FIELDS.every((field) => field in work);
}

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/** A person or agent set this field by an edit, so its value is a correction to keep. */
function editedEmpty(record: ScientSourceRecord, fields: ReadonlyArray<string>): boolean {
  return record.fieldProvenance.some(
    (entry) =>
      fields.includes(entry.field) &&
      entry.sourceField === null &&
      (entry.origin === "user" || entry.origin === "agent"),
  );
}

/**
 * The record with each citation input it lacks taken from the project's snapshot, where the
 * snapshot knows it: an incomplete local record never makes the project's citation poorer. A field
 * an edit emptied stays empty, and a field the record has always wins.
 */
export function withKnownPinCitationValues(
  record: ScientSourceRecord,
  work: ScientPinCitationWork,
): ScientSourceRecord {
  const filled: Record<string, unknown> = {};
  const take = (field: keyof ScientSourceRecord & keyof ScientPinCitationWork) => {
    const known = work[field];
    if (isEmpty(record[field]) && !isEmpty(known) && !editedEmpty(record, [field])) {
      filled[field] = known;
    }
  };
  for (const field of ["title", "creators", "identifiers", "containerTitle", "tags"] as const) {
    take(field);
  }
  for (const field of SCIENT_PIN_CITATION_TEXT_FIELDS) {
    if (field !== "issuedRaw") take(field);
  }
  // The date is one input; a bare year is less than a full date of the same year.
  const recordDate = record.issuedRaw?.trim() ?? "";
  const knownDate = work.issuedRaw?.trim() ?? "";
  const yearOnly = recordDate === "" ? String(record.issuedYear ?? "") : recordDate;
  const lacksDate =
    (recordDate === "" && record.issuedYear === null) ||
    (/^\d{4}$/u.test(yearOnly) && knownDate.length > 4 && knownDate.startsWith(yearOnly));
  if (
    lacksDate &&
    (knownDate !== "" || work.issuedYear !== null) &&
    !editedEmpty(record, ["issuedRaw", "issuedYear"])
  ) {
    filled["issuedRaw"] =
      work.issuedRaw ?? (work.issuedYear === null ? null : String(work.issuedYear));
    filled["issuedYear"] = work.issuedYear;
  }
  return Object.keys(filled).length === 0 ? record : { ...record, ...filled };
}

const fromProjectFile = (sourceField: string | null) =>
  sourceField?.startsWith("project-file:") ?? false;

const CITATION_INPUTS: ReadonlyArray<string> = [
  "type",
  "title",
  "creators",
  "issuedYear",
  "identifiers",
  "containerTitle",
  "tags",
  ...SCIENT_PIN_CITATION_TEXT_FIELDS,
];

/**
 * Whether an older snapshot's managed entry must be kept for this record: it was hydrated from
 * that snapshot, a citation input the snapshot lacks is still unknown, and nobody corrected a
 * citation input since. Edits to anything else (an abstract, a note) change nothing here.
 */
export function scientPinCitationStillUnknown(
  work: ScientPinCitationWork,
  record: ScientSourceRecord,
): boolean {
  if (scientPinWorkIsComplete(work)) return false;
  const provenance = record.fieldProvenance;
  if (!provenance.some((entry) => fromProjectFile(entry.sourceField))) return false;
  const corrected = provenance.some(
    (entry) =>
      CITATION_INPUTS.includes(entry.field) &&
      !fromProjectFile(entry.sourceField) &&
      (entry.origin === "user" || entry.origin === "agent"),
  );
  if (corrected) return false;
  return [...SCIENT_PIN_CITATION_TEXT_FIELDS, "tags" as const].some(
    (field) =>
      !(field in work) &&
      !provenance.some((entry) => entry.field === field && !fromProjectFile(entry.sourceField)),
  );
}

/**
 * A refreshed snapshot keeps a field unknown when the earlier snapshot did not know it and the
 * record only has it from hydrating that snapshot (an empty value, or the date as the year): that
 * is no information. A field an edit or a registry set is known.
 */
export function scientPinWorkKeepingUnknown<W extends ScientPinCitationWork>(
  earlier: ScientPinCitationWork,
  next: W,
  record: ScientSourceRecord,
): W {
  if (!record.fieldProvenance.some((entry) => fromProjectFile(entry.sourceField))) return next;
  const unknown = [...SCIENT_PIN_CITATION_TEXT_FIELDS, "tags" as const].filter(
    (field) =>
      !(field in earlier) &&
      !record.fieldProvenance.some(
        (entry) => entry.field === field && !fromProjectFile(entry.sourceField),
      ) &&
      (isEmpty(next[field]) ||
        (field === "issuedRaw" && next.issuedRaw === String(next.issuedYear))),
  );
  if (unknown.length === 0) return next;
  return Object.fromEntries(
    Object.entries(next).filter(([field]) => !unknown.includes(field as never)),
  ) as W;
}
