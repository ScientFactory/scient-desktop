import { listScientSourcesBulkEdits, readScientSourcesOrganization } from "./collections.ts";
import { readScientLibraryAliases, resolveScientLibraryAlias } from "./libraryAliases.ts";
import { listScientLibraryJoins } from "./libraryJoin.ts";
import { listScientLibraryRecentMerges } from "./libraryMerge.ts";
import { listScientLibraryRestores } from "./libraryRestore.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import type { ScientLibraryRecentChange, ScientLibraryRecentChanges } from "./model.ts";
import {
  listScientSourceIds,
  listScientSourceImports,
  readScientSourceImport,
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
  const [found, present, aliases] = await Promise.all([
    readScientSourceImport(library, operationId),
    listScientSourceIds(library),
    readScientLibraryAliases(library),
  ]);
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
  /** Joins under way in this process; any other unfinished join is one that stopped. */
  runningJoins: ReadonlySet<string> = new Set(),
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
  const [bulkEdits, merges, imports, trash, organization, restores, joins] = await Promise.all([
    listScientSourcesBulkEdits(library, limit + 1),
    listScientLibraryRecentMerges(library, limit + 1),
    listScientSourceImports(library, limit + 1),
    readScientSourcesRemovedByPerson(library, mergedAway),
    readScientSourcesOrganization(library, present),
    listScientLibraryRestores(library),
    listScientLibraryJoins(library, runningJoins),
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
      partsMissing: edit.partsMissing,
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
    ...restores.map((restore) => ({
      kind: "restore" as const,
      id: restore.restoreId,
      at: restore.finishedAt,
      by: restore.by,
      backupCreatedAt: restore.backupCreatedAt,
      sources: restore.sources,
      pdfs: restore.pdfs,
      kept: restore.kept,
    })),
    ...joins.map((join) => ({
      kind: "join" as const,
      id: join.joinId,
      at: join.at,
      by: join.by,
      from: join.other.kind,
      backupCreatedAt: join.other.backupCreatedAt ?? null,
      state: join.state,
      added: join.added,
      different: join.different.length,
      removedHere: join.removedHere,
      left: join.left,
    })),
    // Newest first; changes of the same instant keep one fixed order.
  ].toSorted(
    (left, right) =>
      right.at.localeCompare(left.at) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
  return { changes: changes.slice(0, limit), more: changes.length > limit };
}
