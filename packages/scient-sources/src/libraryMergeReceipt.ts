import * as Schema from "effect/Schema";

import {
  ScientSourceActor,
  ScientSourceExternalReference,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
} from "./model.ts";

const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

const MergeFieldChange = Schema.Struct({
  field: NonEmptyString,
  /** Absent when the survivor had no such key. */
  before: Schema.optionalKey(Schema.Unknown),
  after: Schema.optionalKey(Schema.Unknown),
});

/**
 * A merge receipt in `merges/`. The merge engine and intake both decode a receipt with this one
 * schema, so a file one of them reports as damaged is damaged for the other too.
 */
export const ScientLibraryMerge = Schema.Struct({
  formatVersion: Schema.Literal(1),
  mergeId: NonEmptyString,
  survivorId: NonEmptyString,
  loserId: NonEmptyString,
  kind: Schema.Literals(["same-zotero-item", "same-identifier", "same-pdf", "requested"]),
  state: Schema.Literals(["pending", "done", "undone"]),
  mergedAt: NonEmptyString,
  mergedBy: ScientSourceActor,
  /** The survivor revision the merge wrote, or its unchanged revision when it gained nothing. */
  survivorRevision: Schema.Int,
  loserRevision: Schema.Int,
  /** Fields the merge set on the survivor, so Undo can revert them and keep later edits. */
  changes: Schema.Array(MergeFieldChange),
  added: Schema.Struct({
    tags: Schema.Array(Schema.String),
    identifiers: Schema.Array(ScientSourceIdentifier),
    attachmentSha256: Schema.Array(NonEmptyString),
    externalReferences: Schema.Array(ScientSourceExternalReference),
    fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  }),
  /** The merge report: values the survivor kept over different ones the loser had. */
  conflicts: Schema.Array(
    Schema.Struct({ field: NonEmptyString, kept: Schema.Unknown, other: Schema.Unknown }),
  ),
  zoteroBaseCopied: Schema.Boolean,
  /** Collections the loser was moved out of, and those the survivor joined by it. */
  collectionIds: Schema.Array(NonEmptyString),
  addedToCollectionIds: Schema.Array(NonEmptyString),
  undoneAt: Schema.optionalKey(NonEmptyString),
  undoneBy: Schema.optionalKey(ScientSourceActor),
});
export type ScientLibraryMerge = typeof ScientLibraryMerge.Type;
