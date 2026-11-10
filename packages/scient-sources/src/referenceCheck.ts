import * as Schema from "effect/Schema";

import { ScientSourceActor, ScientSourceIdentifier } from "./model.ts";

const NonEmptyString = Schema.String.check(
  Schema.isTrimmed({ toJsonSchema: () => [{}, true] }),
  Schema.isNonEmpty(),
);
const NullableText = Schema.NullOr(Schema.String);
const ProjectPath = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_096)));

export const ScientReferenceCheckTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("library"),
    /** Only these sources, as when an agent checks a source before citing it. */
    sourceIds: Schema.optionalKey(
      Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(50))),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("file"), path: ProjectPath }),
]);
export type ScientReferenceCheckTarget = typeof ScientReferenceCheckTarget.Type;

export const ScientReferenceFindingKind = Schema.Literals([
  "identifier-not-found",
  "identifier-mismatch",
  "retracted",
  "editorial-notice",
  "cited-not-listed",
  "details-differ",
  "missing-field",
  "duplicate-key",
  "same-work",
  "published-version",
  "listed-not-cited",
]);
export type ScientReferenceFindingKind = typeof ScientReferenceFindingKind.Type;

export const ScientReferenceFindingSeverity = Schema.Literals(["problem", "warning", "note"]);
export type ScientReferenceFindingSeverity = typeof ScientReferenceFindingSeverity.Type;

export const SCIENT_REFERENCE_FINDING_SEVERITY: Readonly<
  Record<ScientReferenceFindingKind, ScientReferenceFindingSeverity>
> = {
  "identifier-not-found": "problem",
  "identifier-mismatch": "problem",
  retracted: "problem",
  "cited-not-listed": "problem",
  "editorial-notice": "warning",
  "details-differ": "warning",
  "missing-field": "warning",
  "duplicate-key": "warning",
  "same-work": "warning",
  "published-version": "note",
  "listed-not-cited": "note",
};

export const ScientReferenceBibtexField = Schema.Literals([
  "title",
  "year",
  "journal",
  "journaltitle",
  "booktitle",
  "volume",
  "pages",
  "publisher",
]);
export type ScientReferenceBibtexField = typeof ScientReferenceBibtexField.Type;

export const ScientReferenceSourceField = Schema.Literals([
  "title",
  "issuedYear",
  "containerTitle",
  "volume",
  "pages",
  "publisher",
]);
export type ScientReferenceSourceField = typeof ScientReferenceSourceField.Type;

/** A registry value to write; self-contained so it can be applied without rerunning the check. */
export const ScientReferenceFix = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bibtex-field"),
    path: ProjectPath,
    key: NonEmptyString,
    field: ScientReferenceBibtexField,
    /** The field's current text, or null when the entry lacks it; a mismatch makes the fix stale. */
    current: NullableText,
    value: NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("source-field"),
    sourceId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
    field: ScientReferenceSourceField,
    value: NonEmptyString,
  }),
]);
export type ScientReferenceFix = typeof ScientReferenceFix.Type;

export const ScientReferenceLocation = Schema.Struct({
  path: ProjectPath,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientReferenceLocation = typeof ScientReferenceLocation.Type;

export const ScientReferenceRegistryRecord = Schema.Struct({
  title: NullableText,
  creators: Schema.Array(Schema.String),
  issuedYear: Schema.NullOr(Schema.Int),
  containerTitle: NullableText,
  identifier: ScientSourceIdentifier,
});
export type ScientReferenceRegistryRecord = typeof ScientReferenceRegistryRecord.Type;

export const ScientReferenceFinding = Schema.Struct({
  findingId: NonEmptyString,
  kind: ScientReferenceFindingKind,
  severity: ScientReferenceFindingSeverity,
  key: NullableText,
  label: NullableText,
  location: Schema.NullOr(ScientReferenceLocation),
  sourceId: NullableText,
  message: NonEmptyString,
  registry: Schema.NullOr(ScientReferenceRegistryRecord),
  related: Schema.NullOr(Schema.Struct({ label: NonEmptyString, url: NonEmptyString })),
  fix: Schema.NullOr(ScientReferenceFix),
  ignored: Schema.Boolean,
});
export type ScientReferenceFinding = typeof ScientReferenceFinding.Type;

export const ScientReferenceStatus = Schema.Literals([
  "ok",
  "problem",
  "no-identifier",
  "unavailable",
]);
export type ScientReferenceStatus = typeof ScientReferenceStatus.Type;

export const ScientReferenceLedgerEntry = Schema.Struct({
  key: NullableText,
  label: NullableText,
  location: Schema.NullOr(ScientReferenceLocation),
  sourceId: NullableText,
  identifier: Schema.NullOr(ScientSourceIdentifier),
  status: ScientReferenceStatus,
});
export type ScientReferenceLedgerEntry = typeof ScientReferenceLedgerEntry.Type;

export const SCIENT_REFERENCE_CHECK_LIMITS = {
  references: 500,
  findings: 300,
} as const;

export const ScientReferenceCheckReport = Schema.Struct({
  target: ScientReferenceCheckTarget,
  checkedAt: NonEmptyString,
  /** Project files read: the document and the bibliography files it names. */
  files: Schema.Array(ProjectPath),
  references: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  citations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checked: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  noIdentifier: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unavailable: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Every reference was read and every identifier answered by its registry. */
  complete: Schema.Boolean,
  findings: Schema.Array(ScientReferenceFinding),
  omittedFindings: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ledger: Schema.Array(ScientReferenceLedgerEntry),
  notes: Schema.Array(NonEmptyString),
});
export type ScientReferenceCheckReport = typeof ScientReferenceCheckReport.Type;

export const ScientReferenceFixOutcome = Schema.Literals([
  "applied",
  "unchanged",
  "stale",
  "not-found",
  "failed",
]);
export type ScientReferenceFixOutcome = typeof ScientReferenceFixOutcome.Type;

export const ScientReferenceResolution = Schema.Struct({
  fixes: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      outcome: ScientReferenceFixOutcome,
      message: NonEmptyString,
    }),
  ),
  ignored: Schema.Array(NonEmptyString),
  restored: Schema.Array(NonEmptyString),
});
export type ScientReferenceResolution = typeof ScientReferenceResolution.Type;

export const ScientReferenceIgnoreList = Schema.Struct({
  formatVersion: Schema.Literal(1),
  findings: Schema.Array(
    Schema.Struct({
      findingId: NonEmptyString,
      ignoredAt: NonEmptyString,
      ignoredBy: ScientSourceActor,
    }),
  ),
});
export type ScientReferenceIgnoreList = typeof ScientReferenceIgnoreList.Type;

export const SCIENT_REFERENCE_IGNORE_FILE = ".scient/reference-check/ignored.json";
