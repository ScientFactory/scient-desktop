import * as Schema from "effect/Schema";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const Keys = Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(10_000)));

export const ScientManagedBibliographyFileName = Schema.Literals([
  "references.bib",
  "references.json",
]);
export type ScientManagedBibliographyFileName = typeof ScientManagedBibliographyFileName.Type;

export const ScientManagedBibliographyFileStatus = Schema.Struct({
  name: ScientManagedBibliographyFileName,
  state: Schema.Literals(["current", "edited", "unmanaged", "absent"]),
  changes: Schema.NullOr(Schema.Struct({ added: Keys, changed: Keys, removed: Keys })),
});
export type ScientManagedBibliographyFileStatus = typeof ScientManagedBibliographyFileStatus.Type;

export const ScientManagedBibliographyStatus = Schema.Struct({
  files: Schema.Array(ScientManagedBibliographyFileStatus),
  citedSourceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScientManagedBibliographyStatus = typeof ScientManagedBibliographyStatus.Type;

export const ScientManagedBibliographySyncRequest = Schema.Struct({
  root: NonEmptyString,
  /** Files edited by hand that should be written over from the Library. */
  replaceEdited: Schema.optionalKey(Schema.Array(ScientManagedBibliographyFileName)),
});
export type ScientManagedBibliographySyncRequest = typeof ScientManagedBibliographySyncRequest.Type;
