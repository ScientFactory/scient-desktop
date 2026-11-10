// @effect-diagnostics nodeBuiltinImport:off -- Collections share the project store's filesystem boundary.
// @effect-diagnostics globalDate:off -- Portable project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import {
  editableMetadataEquals,
  editableMetadataFromRecord,
  normalizeScientSourceEditableMetadata,
} from "./editable.ts";
import type { ScientSourceActor, ScientSourceEditableMetadata } from "./model.ts";
import {
  applyScientSourceTagChanges,
  scientSourceTagKey,
  ScientSourceCollectionsDocument,
  ScientSourcesBulkReceipt,
  SCIENT_SOURCE_COLLECTION_LIMIT,
  SCIENT_SOURCE_COLLECTION_MEMBER_LIMIT,
  SCIENT_SOURCE_SAVED_SEARCH_LIMIT,
  type ScientSourceCollection,
  type ScientSourceFilter,
  type ScientSourceSavedSearch,
  type ScientSourcesBulkFields,
  type ScientSourcesBulkRequestChange,
  type ScientSourcesBulkResult,
  type ScientSourcesOrganization,
  type ScientSourcesOrganizeAction,
  type ScientSourcesOrganizeResult,
} from "./organize.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  SCIENT_SOURCES_DIRECTORY,
  scientSourceStoreInternals,
  updateScientSourceMetadata,
} from "./store.ts";

export const SCIENT_SOURCE_COLLECTIONS_FILE = `${SCIENT_SOURCES_DIRECTORY}/collections.json`;
const SCIENT_SOURCE_BULK_EDITS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/bulk-edits`;
const MAX_BULK_RECEIPT_BYTES = 4 * 1024 * 1024;
const BULK_RECEIPT_LIMIT = 50;

const MAX_COLLECTIONS_BYTES = 8 * 1024 * 1024;
const DELETED_ENTRY_LIMIT = 50;
const {
  sourceStorePaths,
  snapshot,
  readBoundedJson,
  atomicWriteJson,
  withOperationLock,
  assertSafeIdentifier,
} = scientSourceStoreInternals;
const validateBulkReceipt = Schema.decodeSync(ScientSourcesBulkReceipt);

const validateCollectionsDocument = Schema.decodeSync(ScientSourceCollectionsDocument);

const EMPTY_DOCUMENT: ScientSourceCollectionsDocument = {
  formatVersion: 1,
  collections: [],
  savedSearches: [],
};

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function newId(prefix: string): string {
  return `${prefix}_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
}

async function readDocument(root: string): Promise<ScientSourceCollectionsDocument> {
  const filePath = NodePath.join(root, SCIENT_SOURCE_COLLECTIONS_FILE);
  const state = await snapshot(filePath);
  if (state === "missing") return EMPTY_DOCUMENT;
  if (state !== "file") throw new Error("collections.json is not a safe regular file.");
  return readBoundedJson(filePath, MAX_COLLECTIONS_BYTES, ScientSourceCollectionsDocument);
}

function trimDeleted<A extends { readonly deletedAt?: string }>(
  entries: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const deleted = entries
    .filter((entry) => entry.deletedAt !== undefined)
    .toSorted((left, right) => (right.deletedAt ?? "").localeCompare(left.deletedAt ?? ""));
  const dropped = new Set(deleted.slice(DELETED_ENTRY_LIMIT));
  return entries.filter((entry) => !dropped.has(entry));
}

function projectOrganization(
  document: ScientSourceCollectionsDocument,
  presentSourceIds: ReadonlySet<string>,
): ScientSourcesOrganization {
  return {
    collections: document.collections
      .filter((collection) => collection.deletedAt === undefined)
      .map((collection) => collectionSummary(collection, presentSourceIds)),
    savedSearches: document.savedSearches
      .filter((search) => search.deletedAt === undefined)
      .map(savedSearchSummary),
  };
}

/**
 * A damaged collections file must not take the Library down with it, so reads report it and
 * show no collections. Writes refuse instead, so nothing overwrites what a person may repair.
 */
export async function readScientSourcesOrganization(
  root: string,
  presentSourceIds?: ReadonlySet<string>,
): Promise<ScientSourcesOrganization> {
  const paths = await sourceStorePaths(root);
  const present =
    presentSourceIds ??
    new Set((await listScientSourceRecords(paths.root)).map((record) => record.sourceId));
  try {
    return projectOrganization(await readDocument(paths.root), present);
  } catch {
    return {
      collections: [],
      savedSearches: [],
      issue: `${SCIENT_SOURCE_COLLECTIONS_FILE} could not be read. Collections and saved searches are hidden until it is fixed.`,
    };
  }
}

async function mutate<A>(
  root: string,
  change: (
    document: ScientSourceCollectionsDocument,
    context: { readonly now: string; readonly presentSourceIds: ReadonlySet<string> },
  ) => { readonly document: ScientSourceCollectionsDocument | null; readonly result: A },
): Promise<A> {
  const paths = await sourceStorePaths(root);
  return withOperationLock(`${paths.root}:collections-write`, async () => {
    const document = await readDocument(paths.root);
    const presentSourceIds = new Set(
      (await listScientSourceRecords(paths.root)).map((record) => record.sourceId),
    );
    const { document: next, result } = change(document, {
      now: new Date().toISOString(),
      presentSourceIds,
    });
    if (next) {
      const bounded: ScientSourceCollectionsDocument = {
        formatVersion: 1,
        collections: trimDeleted(next.collections),
        savedSearches: trimDeleted(next.savedSearches),
      };
      validateCollectionsDocument(bounded);
      await atomicWriteJson(
        NodePath.join(paths.root, SCIENT_SOURCE_COLLECTIONS_FILE),
        bounded,
        MAX_COLLECTIONS_BYTES,
      );
    }
    return result;
  });
}

function liveCollectionByName(
  document: ScientSourceCollectionsDocument,
  name: string,
): ScientSourceCollection | undefined {
  return document.collections.find(
    (collection) =>
      collection.deletedAt === undefined && nameKey(collection.name) === nameKey(name),
  );
}

function replaceCollection(
  document: ScientSourceCollectionsDocument,
  collection: ScientSourceCollection,
): ScientSourceCollectionsDocument {
  return {
    ...document,
    collections: document.collections.map((entry) =>
      entry.collectionId === collection.collectionId ? collection : entry,
    ),
  };
}

function addMembers(
  collection: ScientSourceCollection,
  sourceIds: ReadonlyArray<string>,
  presentSourceIds: ReadonlySet<string>,
) {
  const members = new Set(collection.sourceIds);
  const added: string[] = [];
  const unknown: string[] = [];
  for (const sourceId of new Set(sourceIds)) {
    if (!presentSourceIds.has(sourceId)) unknown.push(sourceId);
    else if (!members.has(sourceId)) {
      members.add(sourceId);
      added.push(sourceId);
    }
  }
  if (members.size > SCIENT_SOURCE_COLLECTION_MEMBER_LIMIT) {
    throw new Error(
      `A collection can hold at most ${SCIENT_SOURCE_COLLECTION_MEMBER_LIMIT} sources.`,
    );
  }
  return { sourceIds: [...members], added, unknown };
}

export type ScientSourceCollectionChange =
  | {
      readonly outcome:
        | "created"
        | "existing"
        | "renamed"
        | "updated"
        | "unchanged"
        | "deleted"
        | "restored";
      readonly collection: ScientSourceCollection;
      readonly addedSourceIds: ReadonlyArray<string>;
      readonly removedSourceIds: ReadonlyArray<string>;
      readonly unknownSourceIds: ReadonlyArray<string>;
    }
  | {
      readonly outcome: "not-found" | "name-taken";
      readonly collection: ScientSourceCollection | null;
    };

const unchangedMembers = { addedSourceIds: [], removedSourceIds: [], unknownSourceIds: [] };

/** Creating a name that already exists returns that collection, so repeating a request is safe. */
export function createScientSourceCollection(input: {
  readonly root: string;
  readonly name: string;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceCollectionChange> {
  const name = input.name.trim();
  if (!name) return Promise.reject(new Error("A collection needs a name."));
  return mutate<ScientSourceCollectionChange>(input.root, (document, { now, presentSourceIds }) => {
    const existing = liveCollectionByName(document, name);
    const base: ScientSourceCollection = existing ?? {
      collectionId: newId("collection"),
      name,
      sourceIds: [],
      createdAt: now,
      updatedAt: now,
      updatedBy: input.actor,
    };
    const members = addMembers(base, input.sourceIds ?? [], presentSourceIds);
    const changed = !existing || members.added.length > 0;
    const collection: ScientSourceCollection = changed
      ? { ...base, sourceIds: members.sourceIds, updatedAt: now, updatedBy: input.actor }
      : base;
    if (
      !existing &&
      document.collections.filter((entry) => entry.deletedAt === undefined).length >=
        SCIENT_SOURCE_COLLECTION_LIMIT
    ) {
      throw new Error(`A project can have at most ${SCIENT_SOURCE_COLLECTION_LIMIT} collections.`);
    }
    return {
      document: !changed
        ? null
        : existing
          ? replaceCollection(document, collection)
          : { ...document, collections: [...document.collections, collection] },
      result: {
        outcome: existing ? "existing" : "created",
        collection,
        addedSourceIds: members.added,
        removedSourceIds: [],
        unknownSourceIds: members.unknown,
      },
    };
  });
}

function findCollection(document: ScientSourceCollectionsDocument, collectionId: string) {
  return document.collections.find((collection) => collection.collectionId === collectionId);
}

export function renameScientSourceCollection(input: {
  readonly root: string;
  readonly collectionId: string;
  readonly name: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceCollectionChange> {
  const name = input.name.trim();
  if (!name) return Promise.reject(new Error("A collection needs a name."));
  return mutate<ScientSourceCollectionChange>(input.root, (document, { now }) => {
    const current = findCollection(document, input.collectionId);
    if (!current || current.deletedAt !== undefined) {
      return { document: null, result: { outcome: "not-found", collection: null } };
    }
    if (current.name === name) {
      return {
        document: null,
        result: { outcome: "unchanged", collection: current, ...unchangedMembers },
      };
    }
    const clash = liveCollectionByName(document, name);
    if (clash && clash.collectionId !== current.collectionId) {
      return { document: null, result: { outcome: "name-taken", collection: clash } };
    }
    const collection = { ...current, name, updatedAt: now, updatedBy: input.actor };
    return {
      document: replaceCollection(document, collection),
      result: { outcome: "renamed", collection, ...unchangedMembers },
    };
  });
}

/** Deleting a collection never touches its sources, and it can be restored. */
export function deleteScientSourceCollection(input: {
  readonly root: string;
  readonly collectionId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceCollectionChange> {
  return mutate<ScientSourceCollectionChange>(input.root, (document, { now }) => {
    const current = findCollection(document, input.collectionId);
    if (!current) return { document: null, result: { outcome: "not-found", collection: null } };
    if (current.deletedAt !== undefined) {
      return {
        document: null,
        result: { outcome: "unchanged", collection: current, ...unchangedMembers },
      };
    }
    const collection = { ...current, deletedAt: now, updatedAt: now, updatedBy: input.actor };
    return {
      document: replaceCollection(document, collection),
      result: { outcome: "deleted", collection, ...unchangedMembers },
    };
  });
}

export function restoreScientSourceCollection(input: {
  readonly root: string;
  readonly collectionId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceCollectionChange> {
  return mutate<ScientSourceCollectionChange>(input.root, (document, { now }) => {
    const current = findCollection(document, input.collectionId);
    if (!current) return { document: null, result: { outcome: "not-found", collection: null } };
    if (current.deletedAt === undefined) {
      return {
        document: null,
        result: { outcome: "unchanged", collection: current, ...unchangedMembers },
      };
    }
    const clash = liveCollectionByName(document, current.name);
    if (clash) return { document: null, result: { outcome: "name-taken", collection: clash } };
    const { deletedAt: _deletedAt, ...live } = current;
    const collection = { ...live, updatedAt: now, updatedBy: input.actor };
    return {
      document: replaceCollection(document, collection),
      result: { outcome: "restored", collection, ...unchangedMembers },
    };
  });
}

export function changeScientSourceCollectionMembers(input: {
  readonly root: string;
  readonly collectionId: string;
  readonly add?: ReadonlyArray<string>;
  readonly remove?: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceCollectionChange> {
  return mutate<ScientSourceCollectionChange>(input.root, (document, { now, presentSourceIds }) => {
    const current = findCollection(document, input.collectionId);
    if (!current || current.deletedAt !== undefined) {
      return { document: null, result: { outcome: "not-found", collection: null } };
    }
    const removeIds = new Set(input.remove ?? []);
    const removed = current.sourceIds.filter((sourceId) => removeIds.has(sourceId));
    const kept = { ...current, sourceIds: current.sourceIds.filter((id) => !removeIds.has(id)) };
    const members = addMembers(kept, input.add ?? [], presentSourceIds);
    if (removed.length === 0 && members.added.length === 0) {
      return {
        document: null,
        result: {
          outcome: "unchanged",
          collection: current,
          ...unchangedMembers,
          unknownSourceIds: members.unknown,
        },
      };
    }
    const collection = {
      ...current,
      sourceIds: members.sourceIds,
      updatedAt: now,
      updatedBy: input.actor,
    };
    return {
      document: replaceCollection(document, collection),
      result: {
        outcome: "updated",
        collection,
        addedSourceIds: members.added,
        removedSourceIds: removed,
        unknownSourceIds: members.unknown,
      },
    };
  });
}

export type ScientSourceSavedSearchChange =
  | {
      readonly outcome: "created" | "updated" | "unchanged" | "deleted";
      readonly savedSearch: ScientSourceSavedSearch;
    }
  | { readonly outcome: "not-found"; readonly savedSearch: null };

/** Saving under a name that exists replaces that search's filter. */
export function saveScientSourceSearch(input: {
  readonly root: string;
  readonly name: string;
  readonly filter: ScientSourceFilter;
  readonly searchId?: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceSavedSearchChange> {
  const name = input.name.trim();
  if (!name) return Promise.reject(new Error("A saved search needs a name."));
  return mutate<ScientSourceSavedSearchChange>(input.root, (document, { now }) => {
    const live = document.savedSearches.filter((search) => search.deletedAt === undefined);
    const current = input.searchId
      ? live.find((search) => search.searchId === input.searchId)
      : live.find((search) => nameKey(search.name) === nameKey(name));
    if (input.searchId && !current) {
      return { document: null, result: { outcome: "not-found", savedSearch: null } };
    }
    if (
      current &&
      current.name === name &&
      JSON.stringify(current.filter) === JSON.stringify(input.filter)
    ) {
      return { document: null, result: { outcome: "unchanged", savedSearch: current } };
    }
    if (!current && live.length >= SCIENT_SOURCE_SAVED_SEARCH_LIMIT) {
      throw new Error(
        `A project can have at most ${SCIENT_SOURCE_SAVED_SEARCH_LIMIT} saved searches.`,
      );
    }
    const savedSearch: ScientSourceSavedSearch = current
      ? { ...current, name, filter: input.filter, updatedAt: now, updatedBy: input.actor }
      : {
          searchId: newId("search"),
          name,
          filter: input.filter,
          createdAt: now,
          updatedAt: now,
          updatedBy: input.actor,
        };
    return {
      document: {
        ...document,
        savedSearches: current
          ? document.savedSearches.map((search) =>
              search.searchId === savedSearch.searchId ? savedSearch : search,
            )
          : [...document.savedSearches, savedSearch],
      },
      result: { outcome: current ? "updated" : "created", savedSearch },
    };
  });
}

export function deleteScientSourceSearch(input: {
  readonly root: string;
  readonly searchId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceSavedSearchChange> {
  return mutate<ScientSourceSavedSearchChange>(input.root, (document, { now }) => {
    const current = document.savedSearches.find((search) => search.searchId === input.searchId);
    if (!current) return { document: null, result: { outcome: "not-found", savedSearch: null } };
    if (current.deletedAt !== undefined) {
      return { document: null, result: { outcome: "unchanged", savedSearch: current } };
    }
    const savedSearch = { ...current, deletedAt: now, updatedAt: now, updatedBy: input.actor };
    return {
      document: {
        ...document,
        savedSearches: document.savedSearches.map((search) =>
          search.searchId === savedSearch.searchId ? savedSearch : search,
        ),
      },
      result: { outcome: "deleted", savedSearch },
    };
  });
}

function collectionSummary(
  collection: ScientSourceCollection,
  presentSourceIds: ReadonlySet<string>,
) {
  return {
    collectionId: collection.collectionId,
    name: collection.name,
    sourceIds: collection.sourceIds.filter((sourceId) => presentSourceIds.has(sourceId)),
    updatedAt: collection.updatedAt,
    updatedBy: collection.updatedBy,
  };
}

function savedSearchSummary(search: ScientSourceSavedSearch) {
  return {
    searchId: search.searchId,
    name: search.name,
    filter: search.filter,
    updatedAt: search.updatedAt,
    updatedBy: search.updatedBy,
  };
}

/** The single entry point for collection and saved-search changes from HTTP and agent tools. */
export async function organizeScientSources(input: {
  readonly root: string;
  readonly change: ScientSourcesOrganizeAction;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourcesOrganizeResult> {
  const { root, change, actor } = input;
  const collectionResult = async (pending: Promise<ScientSourceCollectionChange>) => {
    const result = await pending;
    if (!result.collection) return { outcome: result.outcome };
    const present = new Set((await listScientSourceRecords(root)).map((record) => record.sourceId));
    return "addedSourceIds" in result
      ? {
          outcome: result.outcome,
          collection: collectionSummary(result.collection, present),
          addedSourceIds: result.addedSourceIds,
          removedSourceIds: result.removedSourceIds,
          unknownSourceIds: result.unknownSourceIds,
        }
      : { outcome: result.outcome, collection: collectionSummary(result.collection, present) };
  };
  const searchResult = async (pending: Promise<ScientSourceSavedSearchChange>) => {
    const result = await pending;
    return result.savedSearch
      ? { outcome: result.outcome, savedSearch: savedSearchSummary(result.savedSearch) }
      : { outcome: result.outcome };
  };
  switch (change.action) {
    case "create-collection":
      return collectionResult(
        createScientSourceCollection({
          root,
          name: change.name,
          sourceIds: change.sourceIds ?? [],
          actor,
        }),
      );
    case "rename-collection":
      return collectionResult(
        renameScientSourceCollection({
          root,
          collectionId: change.collectionId,
          name: change.name,
          actor,
        }),
      );
    case "delete-collection":
      return collectionResult(
        deleteScientSourceCollection({ root, collectionId: change.collectionId, actor }),
      );
    case "restore-collection":
      return collectionResult(
        restoreScientSourceCollection({ root, collectionId: change.collectionId, actor }),
      );
    case "add-to-collection":
      return collectionResult(
        changeScientSourceCollectionMembers({
          root,
          collectionId: change.collectionId,
          add: change.sourceIds,
          actor,
        }),
      );
    case "remove-from-collection":
      return collectionResult(
        changeScientSourceCollectionMembers({
          root,
          collectionId: change.collectionId,
          remove: change.sourceIds,
          actor,
        }),
      );
    case "save-search":
      return searchResult(
        saveScientSourceSearch({
          root,
          name: change.name,
          filter: change.filter,
          ...(change.searchId ? { searchId: change.searchId } : {}),
          actor,
        }),
      );
    case "delete-search":
      return searchResult(deleteScientSourceSearch({ root, searchId: change.searchId, actor }));
  }
}

type BulkFields = ScientSourcesBulkFields;
type BulkSourceResult = ScientSourcesBulkResult["sources"][number];
type BulkConflict = NonNullable<ScientSourcesBulkResult["conflicts"]>[number];

function bulkFields(metadata: ScientSourceEditableMetadata): BulkFields {
  return { type: metadata.type, customType: metadata.customType ?? null, tags: [...metadata.tags] };
}

function sameTags(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const keys = new Set(left.map(scientSourceTagKey));
  return (
    keys.size === new Set(right.map(scientSourceTagKey)).size &&
    right.every((tag) => keys.has(scientSourceTagKey(tag)))
  );
}

/** Rewrites one source's tags and type from its current values, retrying once if it changes. */
async function updateBulkFields(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly actor: ScientSourceActor;
  readonly compute: (current: BulkFields) => {
    readonly next: BulkFields;
    readonly conflicts?: ReadonlyArray<string>;
  };
}): Promise<{
  readonly entry: BulkSourceResult;
  readonly change?: { readonly before: BulkFields; readonly after: BulkFields };
  readonly conflicts: ReadonlyArray<string>;
}> {
  // One retry covers an edit that lands between the read and the write.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await readScientSourceRecord(input.root, input.sourceId);
    if (!record) {
      return {
        entry: { sourceId: input.sourceId, outcome: "not-found", revision: null },
        conflicts: [],
      };
    }
    const current = normalizeScientSourceEditableMetadata(editableMetadataFromRecord(record));
    const { next: fields, conflicts = [] } = input.compute(bulkFields(current));
    const next = normalizeScientSourceEditableMetadata({ ...current, ...fields });
    if (editableMetadataEquals(current, next)) {
      return {
        entry: { sourceId: record.sourceId, outcome: "unchanged", revision: record.revision },
        conflicts,
      };
    }
    try {
      const result = await updateScientSourceMetadata({
        root: input.root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        metadata: next,
        allowPossibleMetadataMatch: true,
        allowExistingValidationIssues: true,
        actor: input.actor,
      });
      if (result.outcome === "stale") continue;
      if (result.outcome === "duplicate") {
        return {
          entry: {
            sourceId: record.sourceId,
            outcome: "failed",
            revision: record.revision,
            message: result.duplicate.reason,
          },
          conflicts,
        };
      }
      const updated = result.outcome === "updated";
      return {
        entry: {
          sourceId: record.sourceId,
          outcome: updated ? "updated" : "unchanged",
          revision: result.record.revision,
        },
        ...(updated
          ? {
              change: {
                before: bulkFields(current),
                after: bulkFields(
                  normalizeScientSourceEditableMetadata(editableMetadataFromRecord(result.record)),
                ),
              },
            }
          : {}),
        conflicts,
      };
    } catch (error) {
      return {
        entry: {
          sourceId: record.sourceId,
          outcome: "failed",
          revision: record.revision,
          message: error instanceof Error ? error.message : "The source could not be updated.",
        },
        conflicts,
      };
    }
  }
  return {
    entry: {
      sourceId: input.sourceId,
      outcome: "failed",
      revision: null,
      message: "The source kept changing while it was updated. Try again.",
    },
    conflicts: [],
  };
}

function bulkEditsDirectory(root: string): string {
  return NodePath.join(root, SCIENT_SOURCE_BULK_EDITS_DIRECTORY);
}

async function writeBulkReceipt(root: string, receipt: ScientSourcesBulkReceipt): Promise<void> {
  const directory = bulkEditsDirectory(root);
  await assertScientProjectDirectory(root, directory, { create: true });
  await atomicWriteJson(
    NodePath.join(directory, `${receipt.batchId}.json`),
    validateBulkReceipt(receipt),
    MAX_BULK_RECEIPT_BYTES,
  );
  const names = (await NodeFSP.readdir(directory))
    .filter((name) => name.startsWith("bulk_") && name.endsWith(".json"))
    .toSorted();
  await Promise.all(
    names
      .slice(0, Math.max(0, names.length - BULK_RECEIPT_LIMIT))
      .map((name) => NodeFSP.rm(NodePath.join(directory, name), { force: true })),
  );
}

async function readBulkReceipt(
  root: string,
  batchId: string,
): Promise<ScientSourcesBulkReceipt | null> {
  assertSafeIdentifier(batchId, "Bulk edit ID");
  try {
    await assertScientProjectDirectory(root, bulkEditsDirectory(root));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const filePath = NodePath.join(bulkEditsDirectory(root), `${batchId}.json`);
  if ((await snapshot(filePath)) === "missing") return null;
  const receipt = await readBoundedJson(filePath, MAX_BULK_RECEIPT_BYTES, ScientSourcesBulkReceipt);
  if (receipt.batchId !== batchId) throw new Error("The bulk edit record is damaged.");
  return receipt;
}

function newBatchId(now: string): string {
  // Sortable by time, so pruning keeps the newest.
  return `bulk_${now.replace(/[^0-9]/gu, "")}_${NodeCrypto.randomUUID().slice(0, 8)}`;
}

/**
 * Applies one change to many sources, reporting each source rather than stopping at the first.
 * What it changed is kept under `undo.batchId` so `{ undoBatchId }` can reverse it.
 */
export async function bulkUpdateScientSources(input: {
  readonly root: string;
  readonly change: ScientSourcesBulkRequestChange;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourcesBulkResult> {
  if ("undoBatchId" in input.change) {
    return undoBulkUpdate({ ...input, batchId: input.change.undoBatchId });
  }
  const change = input.change;
  const paths = await sourceStorePaths(input.root);
  const createdAt = new Date().toISOString();
  const sourceIds = [...new Set(change.sourceIds)];
  const editsRecords =
    (change.addTags?.length ?? 0) > 0 ||
    (change.removeTags?.length ?? 0) > 0 ||
    change.type !== undefined;
  const sources: BulkSourceResult[] = [];
  const receiptSources: ScientSourcesBulkReceipt["sources"][number][] = [];
  for (const sourceId of sourceIds) {
    if (editsRecords) {
      const updated = await updateBulkFields({
        root: paths.root,
        sourceId,
        actor: input.actor,
        compute: (current) => ({
          next: {
            tags: applyScientSourceTagChanges({
              tags: current.tags,
              add: change.addTags,
              remove: change.removeTags,
            }),
            type: change.type ?? current.type,
            customType: change.type
              ? change.type === "other"
                ? (change.customType ?? current.customType)
                : null
              : current.customType,
          },
        }),
      });
      sources.push(updated.entry);
      if (updated.change) receiptSources.push({ sourceId, ...updated.change });
      continue;
    }
    const record = await readScientSourceRecord(paths.root, sourceId);
    sources.push(
      record
        ? { sourceId, outcome: "unchanged", revision: record.revision }
        : { sourceId, outcome: "not-found", revision: null },
    );
  }
  const present = sources
    .filter((entry) => entry.outcome !== "not-found")
    .map((entry) => entry.sourceId);
  const collections: ScientSourcesBulkResult["collections"][number][] = [];
  const receiptCollections: ScientSourcesBulkReceipt["collections"][number][] = [];
  const memberChanges = [
    ...(change.addToCollectionIds ?? []).map((collectionId) => ({ collectionId, add: present })),
    ...(change.removeFromCollectionIds ?? []).map((collectionId) => ({
      collectionId,
      remove: present,
    })),
  ];
  for (const memberChange of memberChanges) {
    if (present.length === 0) break;
    const result = await changeScientSourceCollectionMembers({
      root: paths.root,
      ...memberChange,
      actor: input.actor,
    });
    collections.push({
      collectionId: memberChange.collectionId,
      outcome:
        result.outcome === "updated"
          ? "updated"
          : result.outcome === "unchanged"
            ? "unchanged"
            : "not-found",
    });
    if (result.outcome === "updated") {
      receiptCollections.push({
        collectionId: memberChange.collectionId,
        addedSourceIds: result.addedSourceIds,
        removedSourceIds: result.removedSourceIds,
      });
    }
  }
  if (receiptSources.length === 0 && receiptCollections.length === 0) {
    return { sources, collections };
  }
  const receipt: ScientSourcesBulkReceipt = {
    formatVersion: 1,
    batchId: newBatchId(createdAt),
    createdAt,
    actor: input.actor,
    sources: receiptSources,
    collections: receiptCollections,
  };
  await writeBulkReceipt(paths.root, receipt);
  const changedSourceIds = new Set([
    ...receiptSources.map((entry) => entry.sourceId),
    ...receiptCollections.flatMap((entry) => [...entry.addedSourceIds, ...entry.removedSourceIds]),
  ]);
  return {
    sources,
    collections,
    undo: { batchId: receipt.batchId, sourceCount: changedSourceIds.size },
  };
}

/**
 * Puts back what one bulk edit changed. A value someone changed since is left as it is and
 * reported; tags and memberships are reversed as the exact additions and removals, so later
 * unrelated tags and memberships stay.
 */
async function undoBulkUpdate(input: {
  readonly root: string;
  readonly batchId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourcesBulkResult> {
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:bulk-undo`, async () => {
    const receipt = await readBulkReceipt(paths.root, input.batchId);
    if (!receipt || receipt.undoneAt !== undefined) {
      return {
        sources: [],
        collections: [],
        conflicts: [
          {
            message: receipt
              ? "This bulk edit was already undone."
              : "This bulk edit was not found. Only the latest 50 can be undone.",
          },
        ],
      };
    }
    const sources: BulkSourceResult[] = [];
    const conflicts: BulkConflict[] = [];
    for (const { sourceId, before, after } of receipt.sources) {
      const typeChanged = before.type !== after.type || before.customType !== after.customType;
      const beforeKeys = new Set(before.tags.map(scientSourceTagKey));
      const afterKeys = new Set(after.tags.map(scientSourceTagKey));
      const added = after.tags.filter((tag) => !beforeKeys.has(scientSourceTagKey(tag)));
      const removed = before.tags.filter((tag) => !afterKeys.has(scientSourceTagKey(tag)));
      const result = await updateBulkFields({
        root: paths.root,
        sourceId,
        actor: input.actor,
        compute: (current) => {
          const typeKept =
            typeChanged && (current.type !== after.type || current.customType !== after.customType);
          return {
            next: {
              type: typeChanged && !typeKept ? before.type : current.type,
              customType: typeChanged && !typeKept ? before.customType : current.customType,
              // Untouched since: restore the original order too.
              tags: sameTags(current.tags, after.tags)
                ? before.tags
                : applyScientSourceTagChanges({ tags: current.tags, add: removed, remove: added }),
            },
            conflicts: typeKept
              ? ["Its type was changed after the bulk edit, so the newer type was kept."]
              : [],
          };
        },
      });
      sources.push(result.entry);
      if (result.entry.outcome === "not-found") {
        conflicts.push({ sourceId, message: "The source is no longer in the Library." });
      }
      for (const message of result.conflicts) conflicts.push({ sourceId, message });
    }
    const collections: ScientSourcesBulkResult["collections"][number][] = [];
    for (const delta of receipt.collections.toReversed()) {
      const result = await changeScientSourceCollectionMembers({
        root: paths.root,
        collectionId: delta.collectionId,
        add: delta.removedSourceIds,
        remove: delta.addedSourceIds,
        actor: input.actor,
      });
      if (result.outcome !== "updated" && result.outcome !== "unchanged") {
        collections.push({ collectionId: delta.collectionId, outcome: "not-found" });
        conflicts.push({
          collectionId: delta.collectionId,
          message: "The collection was deleted, so its members were not changed.",
        });
        continue;
      }
      collections.push({ collectionId: delta.collectionId, outcome: result.outcome });
      if ("unknownSourceIds" in result && result.unknownSourceIds.length > 0) {
        conflicts.push({
          collectionId: delta.collectionId,
          message: `${result.unknownSourceIds.length} sources are no longer in the Library and were not put back.`,
        });
      }
    }
    await writeBulkReceipt(paths.root, {
      ...receipt,
      undoneAt: new Date().toISOString(),
      undoneBy: input.actor,
    });
    return { sources, collections, ...(conflicts.length > 0 ? { conflicts } : {}) };
  });
}
