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
  /** Project files holding earlier text of this file that a write moved aside. */
  kept: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ScientManagedBibliographyFileStatus = typeof ScientManagedBibliographyFileStatus.Type;

export const ScientManagedBibliographyStatus = Schema.Struct({
  files: Schema.Array(ScientManagedBibliographyFileStatus),
  citedSourceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Sources added to the Library from hand edits named in `importEdited`. */
  imported: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Keys whose earlier entry was kept: the project's saved details cannot rebuild it here. */
  keptEntries: Schema.optionalKey(Keys),
});
export type ScientManagedBibliographyStatus = typeof ScientManagedBibliographyStatus.Type;

export const ScientManagedBibliographySyncRequest = Schema.Struct({
  root: NonEmptyString,
  /** Files edited by hand that should be written over from the Library. */
  replaceEdited: Schema.optionalKey(Schema.Array(ScientManagedBibliographyFileName)),
  /** Files edited by hand whose new entries should be imported into the Library first. */
  importEdited: Schema.optionalKey(Schema.Array(ScientManagedBibliographyFileName)),
});
export type ScientManagedBibliographySyncRequest = typeof ScientManagedBibliographySyncRequest.Type;

/** A CSL style ID as the CSL style repository names it, e.g. `nature`. */
export const ScientCitationStyleId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u),
  Schema.isMaxLength(200),
);

const StyleName = Schema.Struct({ id: ScientCitationStyleId, title: Schema.String });

export const ScientCitationStyleSummary = Schema.Struct({
  ...StyleName.fields,
  titleShort: Schema.NullOr(Schema.String),
  /** Uses another style's layout; Scient saves that parent style with it. */
  dependent: Schema.Boolean,
  /** Ships with Scient, so it works without a network. */
  bundled: Schema.Boolean,
});
export type ScientCitationStyleSummary = typeof ScientCitationStyleSummary.Type;

/** The project's citation style, saved under `.scient/citations`. */
export const ScientProjectCitationStyle = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("ready", {
    ...StyleName.fields,
    parent: Schema.NullOr(StyleName),
    /** The style to render: the parent's layout for a dependent style. */
    xml: Schema.String,
  }),
  /** The style is named but its file is missing or not a CSL style; `message` says which. */
  Schema.TaggedStruct("unavailable", { ...StyleName.fields, message: Schema.String }),
]);
export type ScientProjectCitationStyle = typeof ScientProjectCitationStyle.Type;

export const ScientCitationStylesRequest = Schema.Struct({
  root: NonEmptyString,
  /** A journal or style name; without one, the bundled styles are listed. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type ScientCitationStylesRequest = typeof ScientCitationStylesRequest.Type;

export const ScientCitationStylesResult = Schema.Struct({
  current: ScientProjectCitationStyle,
  results: Schema.Array(ScientCitationStyleSummary),
  /** Set when the online catalogue could not be searched, saying what was searched instead. */
  catalogueMessage: Schema.NullOr(Schema.String),
});
export type ScientCitationStylesResult = typeof ScientCitationStylesResult.Type;

export const ScientCitationStyleSetRequest = Schema.Struct({
  root: NonEmptyString,
  /** Null clears the project's style. */
  styleId: Schema.NullOr(ScientCitationStyleId),
});
export type ScientCitationStyleSetRequest = typeof ScientCitationStyleSetRequest.Type;

export const ScientCitationStyleSetResult = Schema.Struct({
  /** The project's style after the change; unchanged when `error` is set. */
  style: ScientProjectCitationStyle,
  /** Why the style could not be set, e.g. a failed download or an unknown ID. */
  error: Schema.NullOr(Schema.String),
});
export type ScientCitationStyleSetResult = typeof ScientCitationStyleSetResult.Type;
