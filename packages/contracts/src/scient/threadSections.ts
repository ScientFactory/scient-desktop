import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadSectionId, TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * Section identity belongs to the thread's own environment. Removing catalog entries preserves
 * membership IDs so Undo/restoration reconnects threads; missing sections display as unsectioned
 * without rewriting history.
 */
/** A physical project: the environment it lives on and its id there. */
export const ThreadSectionProjectRef = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
});
export type ThreadSectionProjectRef = typeof ThreadSectionProjectRef.Type;

export const ThreadSection = Schema.Struct({
  id: ThreadSectionId,
  name: TrimmedNonEmptyString,
  order: NonNegativeInt,
  /** When the section was last seen without threads; drives optional auto-delete. */
  emptySince: Schema.optionalKey(Schema.String),
  /**
   * Environments that have held its threads. Current clients record only the
   * catalog's own environment. Entries written when one primary catalog served
   * every environment can list others; clients of that version still read
   * this to decide when they may judge a section empty.
   */
  environmentIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Creation projects keep empty sections visible until threads determine placement. Once occupied
   * anywhere, project-scoped visibility follows actual threads rather than this creation hint.
   */
  createdInProjects: Schema.optionalKey(Schema.Array(ThreadSectionProjectRef)),
});
export type ThreadSection = typeof ThreadSection.Type;

export const ThreadSections = Schema.Array(ThreadSection);
export type ThreadSections = typeof ThreadSections.Type;

/**
 * The catalog a section edit was based on. Clients replace the whole catalog,
 * so a patch carrying this only applies its section keys while the stored
 * catalog still matches; otherwise they are dropped and the client, seeing its
 * edit missing from the returned settings, reapplies it to the fresh catalog.
 */
export const ThreadSectionsPrecondition = Schema.Struct({
  threadSections: ThreadSections,
  threadSectionsGeneralIndex: NonNegativeInt,
});
export type ThreadSectionsPrecondition = typeof ThreadSectionsPrecondition.Type;

/**
 * Whether two catalogs hold the same entries in the same order. Leaves out
 * `createdInProjects`: clients that predate it drop the field when they read
 * the catalog, and must still pass the write precondition. The server keeps
 * the stored refs on every write instead, since refs are only ever added.
 */
export function threadSectionCatalogsEqual(left: ThreadSections, right: ThreadSections): boolean {
  const sameIds = (a?: ReadonlyArray<string>, b?: ReadonlyArray<string>) =>
    (a ?? []).length === (b ?? []).length && (a ?? []).every((id, index) => id === b?.[index]);
  return (
    left.length === right.length &&
    left.every((section, index) => {
      const other = right[index]!;
      return (
        section.id === other.id &&
        section.name === other.name &&
        section.order === other.order &&
        section.emptySince === other.emptySince &&
        sameIds(section.environmentIds, other.environmentIds)
      );
    })
  );
}
