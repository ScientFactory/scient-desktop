import { listScientSourcesBulkEdits, readScientSourcesOrganization } from "./collections.ts";
import { readScientLibraryAliases, resolveScientLibraryAlias } from "./libraryAliases.ts";
import { listScientLibraryRecentMerges } from "./libraryMerge.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import type { ScientLibraryRecentChange, ScientLibraryRecentChanges } from "./model.ts";
import {
  listScientSourceIds,
  listScientSourceImports,
  readScientSourcesRemovedByPerson,
} from "./store.ts";

/** The imported sources that are in the Library now; a merged one is the source that kept it. */
function availableNow(
  importedSourceIds: ReadonlyArray<string>,
  aliases: Awaited<ReturnType<typeof readScientLibraryAliases>>,
  present: ReadonlySet<string>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      importedSourceIds
        .map((sourceId) => resolveScientLibraryAlias(aliases, sourceId))
        .filter((sourceId) => present.has(sourceId)),
    ),
  ];
}

/** The sources of one import that are in the Library now, for showing them; reads only. */
export async function listScientLibraryImportSources(
  library: ScientLibraryLocation,
  operationId: string,
): Promise<ReadonlyArray<string>> {
  const [imports, present, aliases] = await Promise.all([
    listScientSourceImports(library, Number.MAX_SAFE_INTEGER),
    listScientSourceIds(library),
    readScientLibraryAliases(library),
  ]);
  const found = imports.find((entry) => entry.operationId === operationId);
  return found ? availableNow(found.importedSourceIds, aliases, present) : [];
}

/**
 * The Library's recent changes that a record on disk still describes, newest first; reads
 * only. Not a history: a restored source leaves the Trash and this list, edits of one source
 * are in that source's versions, and only the latest 250 bulk edit requests are kept.
 */
export async function listScientLibraryRecentChanges(
  library: ScientLibraryLocation,
  limit: number,
): Promise<ScientLibraryRecentChanges> {
  const [present, aliases] = await Promise.all([
    listScientSourceIds(library),
    readScientLibraryAliases(library),
  ]);
  // A source an alias forwards is a merge's copy, never a removal: its Trash entry is not read.
  const mergedAway = new Set(
    [...aliases.values()].flatMap((alias) =>
      alias.undoneAt === undefined ? [alias.sourceId] : [],
    ),
  );
  const [bulkEdits, merges, imports, trash, organization] = await Promise.all([
    listScientSourcesBulkEdits(library, limit + 1),
    listScientLibraryRecentMerges(library, limit + 1),
    listScientSourceImports(library, limit + 1),
    readScientSourcesRemovedByPerson(library, mergedAway),
    readScientSourcesOrganization(library, present),
  ]);
  const collectionNames = new Map(
    organization.collections.map((collection) => [collection.collectionId, collection.name]),
  );
  const changes: ScientLibraryRecentChange[] = [
    ...bulkEdits.map((edit) => ({
      kind: "bulk-edit" as const,
      id: edit.id,
      at: edit.at,
      by: edit.by,
      parts: edit.parts,
      sourceCount: edit.sourceIds.length,
      tagsAdded: edit.tagsAdded,
      tagsRemoved: edit.tagsRemoved,
      typeChanged: edit.typeChanged,
      collections: edit.collections.map(({ collectionId, ...counts }) => ({
        name: collectionNames.get(collectionId) ?? null,
        ...counts,
      })),
      undone: edit.undone,
      left: edit.left,
    })),
    ...merges.map(({ merge, undo, keptTitle, mergedTitle }) => ({
      kind: "merge" as const,
      id: merge.mergeId,
      at: merge.mergedAt,
      by: merge.mergedBy,
      automatic: merge.kind !== "requested",
      keptSourceId: merge.survivorId,
      keptTitle,
      mergedTitle,
      undo,
    })),
    ...imports.map((entry) => ({
      kind: "import" as const,
      id: entry.operationId,
      at: entry.finishedAt,
      by: entry.by,
      intake: entry.intake,
      outcome: entry.outcome,
      imported: entry.importedSourceIds.length,
      available: availableNow(entry.importedSourceIds, aliases, present).length,
      failed: entry.failed,
    })),
    ...trash.map((entry) => ({
      kind: "trash" as const,
      id: entry.sourceId,
      at: entry.removedAt,
      by: entry.removedBy,
      title: entry.record.title,
      revision: entry.record.revision,
    })),
  ].toSorted((left, right) => (left.at < right.at ? 1 : -1));
  return { changes: changes.slice(0, limit), more: changes.length > limit };
}
