import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadSectionId, TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * A named group the user files threads into. Sections are independent of the
 * lifecycle shelves (pinned, active, snoozed, settled); a thread belongs to at
 * most one. Each environment's server settings hold the catalog of its own
 * sections, and a thread's section id resolves only against the catalog of
 * the thread's environment, so every client connected to that environment
 * sees the same sections. Membership is stored on each thread, so removing a
 * catalog entry leaves its threads' IDs intact: they read as unsectioned, and
 * restoring the entry brings them back.
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
   * The projects the section was created for: the sidebar's selected project,
   * plus the projects of any threads filed into it on creation. A sidebar
   * scoped to one project lists a section once that project has threads in
   * it; while the section has no threads anywhere, it is listed only in these
   * projects (and under All projects).
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
