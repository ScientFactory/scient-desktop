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
  const live = new Set(liveCollectionIds(document));
  return {
    collections: document.collections
      .filter((collection) => collection.deletedAt === undefined)
      .map((collection) => collectionSummary(collection, presentSourceIds, live)),
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
  beforeWrite?: (result: A) => Promise<void>,
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
      await beforeWrite?.(result);
      await atomicWriteJson(
        NodePath.join(paths.root, SCIENT_SOURCE_COLLECTIONS_FILE),
        bounded,
        MAX_COLLECTIONS_BYTES,
      );
    }
    return result;
  });
}

function liveCollectionIds(document: ScientSourceCollectionsDocument): ReadonlyArray<string> {
  return document.collections
    .filter((collection) => collection.deletedAt === undefined)
    .map((collection) => collection.collectionId);
}

/** Names are unique among siblings: two parents can each have a "Methods". */
function liveCollectionByName(
  document: ScientSourceCollectionsDocument,
  name: string,
  parentCollectionId: string | undefined,
): ScientSourceCollection | undefined {
  return document.collections.find(
    (collection) =>
      collection.deletedAt === undefined &&
      collection.parentCollectionId === parentCollectionId &&
      nameKey(collection.name) === nameKey(name),
  );
}

/** Why a collection cannot sit under this parent, or null when it can. */
function nestingProblem(
  document: ScientSourceCollectionsDocument,
  parentCollectionId: string,
  childCollectionId: string | null,
): "not-found" | "too-deep" | null {
  const parent = findCollection(document, parentCollectionId);
  if (!parent || parent.deletedAt !== undefined) return "not-found";
  if (parent.parentCollectionId !== undefined || parentCollectionId === childCollectionId)
    return "too-deep";
  const hasChildren =
    childCollectionId !== null &&
    document.collections.some(
      (collection) =>
        collection.deletedAt === undefined && collection.parentCollectionId === childCollectionId,
    );
  return hasChildren ? "too-deep" : null;
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
      readonly outcome: "not-found" | "name-taken" | "too-deep";
      readonly collection: ScientSourceCollection | null;
    };

const unchangedMembers = { addedSourceIds: [], removedSourceIds: [], unknownSourceIds: [] };

/** Creating a name that already exists returns that collection, so repeating a request is safe. */
export function createScientSourceCollection(input: {
  readonly root: string;
  readonly name: string;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly parentCollectionId?: string;
  readonly actor: ScientSourceActor;
  /** The id a new collection gets, chosen by a bulk edit that records it first. */
  readonly collectionId?: string;
  readonly beforeWrite?: (change: ScientSourceCollectionChange) => Promise<void>;
}): Promise<ScientSourceCollectionChange> {
  const name = input.name.trim();
  if (!name) return Promise.reject(new Error("A collection needs a name."));
  const parentCollectionId = input.parentCollectionId;
  return mutate<ScientSourceCollectionChange>(
    input.root,
    (document, { now, presentSourceIds }) => {
      const problem = parentCollectionId
        ? nestingProblem(document, parentCollectionId, null)
        : null;
      if (problem) return { document: null, result: { outcome: problem, collection: null } };
      const existing = liveCollectionByName(document, name, parentCollectionId);
      const base: ScientSourceCollection = existing ?? {
        collectionId: input.collectionId ?? newId("collection"),
        name,
        ...(parentCollectionId ? { parentCollectionId } : {}),
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
        throw new Error(
          `A project can have at most ${SCIENT_SOURCE_COLLECTION_LIMIT} collections.`,
        );
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
    },
    input.beforeWrite,
  );
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
    const clash = liveCollectionByName(document, name, current.parentCollectionId);
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

/** Puts a collection under a top-level parent, or (null) back at the top level. */
function moveScientSourceCollection(input: {
  readonly root: string;
  readonly collectionId: string;
  readonly parentCollectionId: string | null;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceCollectionChange> {
  const parentCollectionId = input.parentCollectionId ?? undefined;
  return mutate<ScientSourceCollectionChange>(input.root, (document, { now }) => {
    const current = findCollection(document, input.collectionId);
    if (!current || current.deletedAt !== undefined) {
      return { document: null, result: { outcome: "not-found", collection: null } };
    }
    if (current.parentCollectionId === parentCollectionId) {
      return {
        document: null,
        result: { outcome: "unchanged", collection: current, ...unchangedMembers },
      };
    }
    const problem = parentCollectionId
      ? nestingProblem(document, parentCollectionId, current.collectionId)
      : null;
    if (problem) return { document: null, result: { outcome: problem, collection: current } };
    const clash = liveCollectionByName(document, current.name, parentCollectionId);
    if (clash) return { document: null, result: { outcome: "name-taken", collection: clash } };
    const { parentCollectionId: _previous, ...rest } = current;
    const collection: ScientSourceCollection = {
      ...rest,
      ...(parentCollectionId ? { parentCollectionId } : {}),
      updatedAt: now,
      updatedBy: input.actor,
    };
    return {
      document: replaceCollection(document, collection),
      result: { outcome: "updated", collection, ...unchangedMembers },
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
    const clash = liveCollectionByName(document, current.name, current.parentCollectionId);
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
  /** Runs inside the write lock before an update is saved; a failure leaves it unsaved. */
  readonly beforeWrite?: (change: ScientSourceCollectionChange) => Promise<void>;
}): Promise<ScientSourceCollectionChange> {
  return mutate<ScientSourceCollectionChange>(
    input.root,
    (document, { now, presentSourceIds }) => {
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
    },
    input.beforeWrite,
  );
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
  liveIds: ReadonlySet<string>,
) {
  const parent = collection.parentCollectionId;
  return {
    collectionId: collection.collectionId,
    name: collection.name,
    ...(parent && liveIds.has(parent) ? { parentCollectionId: parent } : {}),
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
    const live = new Set(liveCollectionIds(await readDocument(root)));
    return "addedSourceIds" in result
      ? {
          outcome: result.outcome,
          collection: collectionSummary(result.collection, present, live),
          addedSourceIds: result.addedSourceIds,
          removedSourceIds: result.removedSourceIds,
          unknownSourceIds: result.unknownSourceIds,
        }
      : {
          outcome: result.outcome,
          collection: collectionSummary(result.collection, present, live),
        };
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
          ...(change.parentCollectionId ? { parentCollectionId: change.parentCollectionId } : {}),
          actor,
        }),
      );
    case "move-collection":
      return collectionResult(
        moveScientSourceCollection({
          root,
          collectionId: change.collectionId,
          parentCollectionId: change.parentCollectionId,
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

function sameFields(left: BulkFields, right: BulkFields): boolean {
  return (
    left.type === right.type &&
    left.customType === right.customType &&
    sameTags(left.tags, right.tags)
  );
}

/**
 * Rewrites one source's tags and type from its current values, retrying once if it changes.
 * `beforeWrite` runs before each write with the revision it replaces; if it fails, nothing is
 * written. `uncertain` means the write failed part way, so it may have landed.
 */
async function updateBulkFields(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly actor: ScientSourceActor;
  readonly compute: (current: BulkFields) => {
    readonly next: BulkFields;
    readonly conflicts?: ReadonlyArray<string>;
  };
  readonly beforeWrite?: (change: {
    readonly before: BulkFields;
    readonly after: BulkFields;
    readonly revision: number;
  }) => Promise<void>;
}): Promise<{
  readonly entry: BulkSourceResult;
  readonly change?: { readonly before: BulkFields; readonly after: BulkFields };
  readonly conflicts: ReadonlyArray<string>;
  readonly uncertain?: true;
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
      await input.beforeWrite?.({
        before: bulkFields(current),
        after: bulkFields(next),
        revision: record.revision,
      });
    } catch (error) {
      return {
        entry: {
          sourceId: record.sourceId,
          outcome: "failed",
          revision: record.revision,
          message: failureMessage(error, "Undo could not be saved."),
        },
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
        uncertain: true,
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

function bulkReceiptPath(root: string, batchId: string): string {
  return NodePath.join(bulkEditsDirectory(root), `${batchId}.json`);
}

async function writeBulkReceipt(
  root: string,
  receipt: ScientSourcesBulkReceipt,
  options: { readonly prune?: boolean } = {},
): Promise<void> {
  const directory = bulkEditsDirectory(root);
  await assertScientProjectDirectory(root, directory, { create: true });
  await atomicWriteJson(
    bulkReceiptPath(root, receipt.batchId),
    validateBulkReceipt(receipt),
    MAX_BULK_RECEIPT_BYTES,
  );
  if (!options.prune) return;
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
  const filePath = bulkReceiptPath(root, batchId);
  if ((await snapshot(filePath)) === "missing") return null;
  const receipt = await readBoundedJson(filePath, MAX_BULK_RECEIPT_BYTES, ScientSourcesBulkReceipt);
  if (receipt.batchId !== batchId) throw new Error("The bulk edit record is damaged.");
  return receipt;
}

function newBatchId(now: string): string {
  // Sortable by time, so pruning keeps the newest.
  return `bulk_${now.replace(/[^0-9]/gu, "")}_${NodeCrypto.randomUUID().slice(0, 8)}`;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type BulkReceiptSource = ScientSourcesBulkReceipt["sources"][number];
type BulkReceiptCollection = ScientSourcesBulkReceipt["collections"][number];
type BulkCollectionResult = ScientSourcesBulkResult["collections"][number];

function replaceEntry<A>(entries: A[], entry: A, next?: A): void {
  const index = entries.indexOf(entry);
  if (index === -1) return;
  if (next === undefined) entries.splice(index, 1);
  else entries[index] = next;
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
  const edit = "themes" in change ? null : change;
  const paths = await sourceStorePaths(input.root);
  const createdAt = new Date().toISOString();
  const batchId = newBatchId(createdAt);
  const sourceIds = edit ? [...new Set(edit.sourceIds)] : [];
  const editsRecords =
    (edit?.addTags?.length ?? 0) > 0 ||
    (edit?.removeTags?.length ?? 0) > 0 ||
    edit?.type !== undefined;
  const sources: BulkSourceResult[] = [];
  const collections: BulkCollectionResult[] = [];
  const receiptSources: BulkReceiptSource[] = [];
  const receiptCollections: BulkReceiptCollection[] = [];
  const publish = (options?: { readonly prune?: boolean }) =>
    writeBulkReceipt(
      paths.root,
      {
        formatVersion: 1,
        batchId,
        createdAt,
        actor: input.actor,
        sources: receiptSources,
        collections: receiptCollections,
      },
      options,
    );
  // Each change is recorded as pending before it is made, so a receipt that cannot be written
  // refuses it, and finished after. One that cannot be finished stays pending for Undo, which
  // checks whether it landed.
  await publish({ prune: true });
  let unsaved = null as string | null;
  const stop = (error: unknown, prefix: string): string => {
    unsaved = `Not changed because Undo could not be saved. ${failureMessage(error, "")}`.trim();
    return `${prefix} ${failureMessage(error, "")}`.trim();
  };
  const writeAhead = async (add: () => void, remove: () => void): Promise<void> => {
    add();
    try {
      await publish();
    } catch (error) {
      remove();
      throw new Error(stop(error, "Not changed because Undo could not be saved."), {
        cause: error,
      });
    }
  };
  const finish = async (settle: () => void): Promise<string | undefined> => {
    settle();
    try {
      await publish();
      return undefined;
    } catch (error) {
      return stop(error, "Changed, but the rest was not because Undo could not be saved.");
    }
  };
  try {
    for (const sourceId of sourceIds) {
      if (unsaved !== null) {
        sources.push({ sourceId, outcome: "failed", revision: null, message: unsaved });
        continue;
      }
      if (!editsRecords) {
        const existing = await readScientSourceRecord(paths.root, sourceId);
        sources.push(
          existing
            ? { sourceId, outcome: "unchanged", revision: existing.revision }
            : { sourceId, outcome: "not-found", revision: null },
        );
        continue;
      }
      const intent = { entry: null as BulkReceiptSource | null };
      const updated = await updateBulkFields({
        root: paths.root,
        sourceId,
        actor: input.actor,
        compute: (current) => ({
          next: {
            tags: applyScientSourceTagChanges({
              tags: current.tags,
              add: edit?.addTags,
              remove: edit?.removeTags,
            }),
            type: edit?.type ?? current.type,
            customType: edit?.type
              ? edit.type === "other"
                ? (edit.customType ?? current.customType)
                : null
              : current.customType,
          },
        }),
        beforeWrite: (planned) => {
          const previous = intent.entry;
          const entry: BulkReceiptSource = { sourceId, ...planned, pending: true };
          return writeAhead(
            () => {
              if (previous) replaceEntry(receiptSources, previous);
              receiptSources.push(entry);
              intent.entry = entry;
            },
            () => {
              replaceEntry(receiptSources, entry);
              intent.entry = null;
            },
          );
        },
      });
      const written = intent.entry;
      const entryChange = updated.change;
      let message: string | undefined;
      if (written && entryChange) {
        message = await finish(() =>
          replaceEntry(receiptSources, written, {
            sourceId,
            ...entryChange,
            ...(written.revision === undefined ? {} : { revision: written.revision }),
          }),
        );
      } else if (written && !updated.uncertain) {
        // Known not to have landed, so Undo has nothing to check.
        replaceEntry(receiptSources, written);
        await publish().catch(() => undefined);
      }
      sources.push(message ? { ...updated.entry, message } : updated.entry);
    }
    const changeMembers = async (
      memberChange: {
        readonly collectionId: string;
        readonly add?: ReadonlyArray<string>;
        readonly remove?: ReadonlyArray<string>;
      },
      label: { readonly name?: string; readonly created?: true } = {},
    ): Promise<void> => {
      const { collectionId } = memberChange;
      if (unsaved !== null) {
        collections.push({ collectionId, ...label, outcome: "failed", message: unsaved });
        return;
      }
      const intent = { entry: null as BulkReceiptCollection | null };
      try {
        const result = await changeScientSourceCollectionMembers({
          root: paths.root,
          ...memberChange,
          actor: input.actor,
          beforeWrite: async (planned) => {
            if (planned.outcome !== "updated") return;
            const entry: BulkReceiptCollection = {
              collectionId,
              addedSourceIds: planned.addedSourceIds,
              removedSourceIds: planned.removedSourceIds,
              updatedAt: planned.collection.updatedAt,
              pending: true,
            };
            await writeAhead(
              () => {
                receiptCollections.push(entry);
                intent.entry = entry;
              },
              () => {
                replaceEntry(receiptCollections, entry);
                intent.entry = null;
              },
            );
          },
        });
        const unknown =
          "unknownSourceIds" in result && result.unknownSourceIds.length > 0
            ? `${result.unknownSourceIds.length} of the sources are not in the Library.`
            : undefined;
        if (result.outcome !== "updated") {
          collections.push({
            collectionId,
            ...label,
            outcome: result.outcome === "unchanged" ? "unchanged" : "not-found",
            ...(unknown ? { message: unknown } : {}),
          });
          return;
        }
        const written = intent.entry;
        const message = written
          ? await finish(() =>
              replaceEntry(receiptCollections, written, {
                collectionId,
                addedSourceIds: written.addedSourceIds,
                removedSourceIds: written.removedSourceIds,
                ...(written.updatedAt === undefined ? {} : { updatedAt: written.updatedAt }),
              }),
            )
          : undefined;
        const note = message ?? unknown;
        collections.push({
          collectionId,
          ...label,
          outcome: "updated",
          ...(note ? { message: note } : {}),
        });
      } catch (error) {
        collections.push({
          collectionId,
          ...label,
          outcome: "failed",
          message: failureMessage(error, "The collection could not be changed."),
        });
      }
    };
    /** A live collection by name under the parent, made (and recorded for Undo) when missing. */
    const ensureCollection = async (
      name: string,
      parentCollectionId: string | undefined,
    ): Promise<{ readonly collectionId: string; readonly created?: true } | string> => {
      if (unsaved !== null) return unsaved;
      const collectionId = newId("collection");
      const intent = { entry: null as BulkReceiptCollection | null };
      try {
        const result = await createScientSourceCollection({
          root: paths.root,
          name,
          ...(parentCollectionId ? { parentCollectionId } : {}),
          collectionId,
          actor: input.actor,
          beforeWrite: async (planned) => {
            if (planned.outcome !== "created" || !planned.collection) return;
            const entry: BulkReceiptCollection = {
              collectionId,
              addedSourceIds: [],
              removedSourceIds: [],
              updatedAt: planned.collection.updatedAt,
              created: true,
              pending: true,
            };
            await writeAhead(
              () => {
                receiptCollections.push(entry);
                intent.entry = entry;
              },
              () => {
                replaceEntry(receiptCollections, entry);
                intent.entry = null;
              },
            );
          },
        });
        if (!result.collection) return "The parent collection could not be used.";
        const written = intent.entry;
        if (result.outcome !== "created" || !written) {
          return { collectionId: result.collection.collectionId };
        }
        const { pending: _pending, ...settled } = written;
        const message = await finish(() => replaceEntry(receiptCollections, written, settled));
        return message ?? { collectionId, created: true };
      } catch (error) {
        return failureMessage(error, "The collection could not be created.");
      }
    };
    if (edit) {
      const present = sources
        .filter((entry) => entry.outcome !== "not-found")
        .map((entry) => entry.sourceId);
      const memberChanges = [
        ...(edit.addToCollectionIds ?? []).map((collectionId) => ({ collectionId, add: present })),
        ...(edit.removeFromCollectionIds ?? []).map((collectionId) => ({
          collectionId,
          remove: present,
        })),
      ];
      for (const memberChange of present.length === 0 ? [] : memberChanges) {
        await changeMembers(memberChange);
      }
    }
    const parents = new Map<string, Awaited<ReturnType<typeof ensureCollection>>>();
    for (const theme of "themes" in change ? change.themes : []) {
      let parentCollectionId: string | undefined;
      if (theme.parent) {
        const key = nameKey(theme.parent);
        const known = parents.get(key);
        const parent = known ?? (await ensureCollection(theme.parent, undefined));
        if (!known) {
          parents.set(key, parent);
          if (typeof parent !== "string" && parent.created) {
            collections.push({
              collectionId: parent.collectionId,
              name: theme.parent,
              created: true,
              outcome: "updated",
            });
          }
        }
        if (typeof parent === "string") {
          collections.push({
            collectionId: newId("collection"),
            name: theme.name,
            outcome: "failed",
            message: parent,
          });
          continue;
        }
        parentCollectionId = parent.collectionId;
      }
      const target = await ensureCollection(theme.name, parentCollectionId);
      if (typeof target === "string") {
        collections.push({
          collectionId: newId("collection"),
          name: theme.name,
          outcome: "failed",
          message: target,
        });
        continue;
      }
      await changeMembers(
        { collectionId: target.collectionId, add: theme.sourceIds },
        { name: theme.name, ...(target.created ? { created: true as const } : {}) },
      );
    }
  } finally {
    if (receiptSources.length === 0 && receiptCollections.length === 0) {
      await NodeFSP.rm(bulkReceiptPath(paths.root, batchId), { force: true }).catch(
        () => undefined,
      );
    }
  }
  if (receiptSources.length === 0 && receiptCollections.length === 0) {
    return { sources, collections };
  }
  const changedSourceIds = new Set([
    ...receiptSources.map((entry) => entry.sourceId),
    ...receiptCollections.flatMap((entry) => [...entry.addedSourceIds, ...entry.removedSourceIds]),
  ]);
  return { sources, collections, undo: { batchId, sourceCount: changedSourceIds.size } };
}

const CHANGED_AFTER_UNDO = "It was changed after Undo started, so the newer values were kept.";
const CHANGED_DURING_EDIT =
  "It was changed while the bulk edit was saved, so it was left as it is.";

/**
 * Whether a write the receipt recorded as about to happen landed. `null` means Undo should
 * restore the entry; otherwise it is settled, with a conflict when a later edit was kept.
 */
function settledSource(
  entry: BulkReceiptSource,
  revision: number,
  current: BulkFields,
): { readonly conflict?: string } | null {
  if (entry.restoring && revision !== entry.restoring.revision) {
    return sameFields(current, entry.restoring.fields) ? {} : { conflict: CHANGED_AFTER_UNDO };
  }
  if (!entry.pending) return null;
  if (revision === entry.revision) return {};
  return sameFields(current, entry.after) ? null : { conflict: CHANGED_DURING_EDIT };
}

function settledCollection(
  entry: BulkReceiptCollection,
  updatedAt: string,
): { readonly conflict?: string } | null {
  if (entry.restoring && updatedAt >= entry.restoring.updatedAt) {
    return updatedAt === entry.restoring.updatedAt ? {} : { conflict: CHANGED_AFTER_UNDO };
  }
  if (!entry.pending || entry.updatedAt === undefined) return null;
  if (updatedAt < entry.updatedAt) return {};
  return updatedAt === entry.updatedAt ? null : { conflict: CHANGED_DURING_EDIT };
}

/**
 * Puts back what one bulk edit changed. A value someone changed since is left as it is and
 * reported; tags and memberships are reversed as the exact additions and removals, so later
 * unrelated tags and memberships stay. Each restore is recorded before it is written and each
 * entry marked when done, so a retry checks what landed and only tries what is left.
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
    const receiptSources = [...receipt.sources];
    const receiptCollections = [...receipt.collections];
    const save = (undoneAt?: string) =>
      writeBulkReceipt(paths.root, {
        ...receipt,
        sources: receiptSources,
        collections: receiptCollections,
        ...(undoneAt ? { undoneAt, undoneBy: input.actor } : {}),
      });
    let unsaved = null as string | null;
    const stop = (error: unknown): string => {
      unsaved = `Not undone because Undo could not be saved. ${failureMessage(error, "")}`.trim();
      return unsaved;
    };
    const intend = async (mark: () => void): Promise<void> => {
      mark();
      try {
        await save();
      } catch (error) {
        throw new Error(stop(error), { cause: error });
      }
    };
    const markDone = async (mark: (undoneAt: string) => void): Promise<string | undefined> => {
      const undoneAt = new Date().toISOString();
      mark(undoneAt);
      const finished = [...receiptSources, ...receiptCollections].every(
        (entry) => entry.undoneAt !== undefined,
      );
      try {
        await save(finished ? undoneAt : undefined);
        return undefined;
      } catch (error) {
        stop(error);
        return `Undone, but that could not be saved. Try again to finish. ${failureMessage(error, "")}`.trim();
      }
    };
    const sources: BulkSourceResult[] = [];
    const conflicts: BulkConflict[] = [];
    for (const [index, entry] of receiptSources.entries()) {
      if (entry.undoneAt !== undefined) continue;
      const { sourceId, before, after } = entry;
      if (unsaved !== null) {
        sources.push({ sourceId, outcome: "failed", revision: null, message: unsaved });
        continue;
      }
      const record = await readScientSourceRecord(paths.root, sourceId);
      const settled = record
        ? settledSource(
            entry,
            record.revision,
            bulkFields(normalizeScientSourceEditableMetadata(editableMetadataFromRecord(record))),
          )
        : null;
      const typeChanged = before.type !== after.type || before.customType !== after.customType;
      const beforeKeys = new Set(before.tags.map(scientSourceTagKey));
      const afterKeys = new Set(after.tags.map(scientSourceTagKey));
      const added = after.tags.filter((tag) => !beforeKeys.has(scientSourceTagKey(tag)));
      const removed = before.tags.filter((tag) => !afterKeys.has(scientSourceTagKey(tag)));
      const result =
        settled && record
          ? {
              entry: { sourceId, outcome: "unchanged" as const, revision: record.revision },
              conflicts: settled.conflict ? [settled.conflict] : [],
            }
          : await updateBulkFields({
              root: paths.root,
              sourceId,
              actor: input.actor,
              compute: (current) => {
                const isType = (fields: BulkFields) =>
                  current.type === fields.type && current.customType === fields.customType;
                const typeKept = typeChanged && !isType(after) && !isType(before);
                return {
                  next: {
                    type: typeChanged && isType(after) ? before.type : current.type,
                    customType:
                      typeChanged && isType(after) ? before.customType : current.customType,
                    // Untouched since: restore the original order too.
                    tags: sameTags(current.tags, after.tags)
                      ? before.tags
                      : applyScientSourceTagChanges({
                          tags: current.tags,
                          add: removed,
                          remove: added,
                        }),
                  },
                  conflicts: typeKept
                    ? ["Its type was changed after the bulk edit, so the newer type was kept."]
                    : [],
                };
              },
              beforeWrite: (planned) =>
                intend(() => {
                  receiptSources[index] = {
                    ...entry,
                    restoring: { revision: planned.revision, fields: planned.after },
                  };
                }),
            });
      if (result.entry.outcome === "failed") {
        sources.push(result.entry);
        continue;
      }
      if (result.entry.outcome === "not-found") {
        conflicts.push({ sourceId, message: "The source is no longer in the Library." });
      }
      for (const message of result.conflicts) conflicts.push({ sourceId, message });
      const unrecorded = await markDone((undoneAt) => {
        receiptSources[index] = { ...(receiptSources[index] ?? entry), undoneAt };
      });
      sources.push(
        unrecorded ? { ...result.entry, outcome: "failed", message: unrecorded } : result.entry,
      );
    }
    const collections: BulkCollectionResult[] = [];
    for (const [index, delta] of [...receiptCollections.entries()].toReversed()) {
      if (delta.undoneAt !== undefined) continue;
      const { collectionId } = delta;
      if (unsaved !== null) {
        collections.push({ collectionId, outcome: "failed", message: unsaved });
        continue;
      }
      const document = await readDocument(paths.root).catch(() => null);
      const existing = document ? findCollection(document, collectionId) : undefined;
      if (delta.created) {
        // Runs after the entries that filled it, as entries are undone newest first.
        const live = existing !== undefined && existing.deletedAt === undefined;
        const inUse =
          live &&
          (existing.sourceIds.length > 0 ||
            document!.collections.some(
              (collection) =>
                collection.deletedAt === undefined &&
                collection.parentCollectionId === collectionId,
            ));
        const removed =
          live && !inUse
            ? await deleteScientSourceCollection({
                root: paths.root,
                collectionId,
                actor: input.actor,
              }).then(
                () => null,
                (error: unknown) => failureMessage(error, "The collection could not be deleted."),
              )
            : null;
        if (removed) {
          collections.push({ collectionId, outcome: "failed", message: removed });
          continue;
        }
        if (inUse) {
          conflicts.push({
            collectionId,
            message: "Sources or collections were added to it since, so it was kept.",
          });
        }
        const unrecorded = await markDone((undoneAt) => {
          receiptCollections[index] = { ...(receiptCollections[index] ?? delta), undoneAt };
        });
        collections.push(
          unrecorded
            ? { collectionId, outcome: "failed", message: unrecorded }
            : { collectionId, outcome: live && !inUse ? "updated" : "unchanged" },
        );
        continue;
      }
      const settled =
        existing && existing.deletedAt === undefined
          ? settledCollection(delta, existing.updatedAt)
          : null;
      const result = settled
        ? ({ outcome: "unchanged" } as const)
        : await changeScientSourceCollectionMembers({
            root: paths.root,
            collectionId,
            add: delta.removedSourceIds,
            remove: delta.addedSourceIds,
            actor: input.actor,
            beforeWrite: async (planned) => {
              if (planned.outcome !== "updated") return;
              await intend(() => {
                receiptCollections[index] = {
                  ...delta,
                  restoring: { updatedAt: planned.collection.updatedAt },
                };
              });
            },
          }).catch((error: unknown) =>
            failureMessage(error, "The collection could not be changed."),
          );
      if (typeof result === "string") {
        collections.push({ collectionId, outcome: "failed", message: result });
        continue;
      }
      if (settled?.conflict) conflicts.push({ collectionId, message: settled.conflict });
      let outcome: "updated" | "unchanged" | "not-found" = "not-found";
      if (result.outcome !== "updated" && result.outcome !== "unchanged") {
        conflicts.push({
          collectionId,
          message: "The collection was deleted, so its members were not changed.",
        });
      } else {
        outcome = result.outcome;
        if ("unknownSourceIds" in result && result.unknownSourceIds.length > 0) {
          conflicts.push({
            collectionId,
            message: `${result.unknownSourceIds.length} sources are no longer in the Library and were not put back.`,
          });
        }
      }
      const unrecorded = await markDone((undoneAt) => {
        receiptCollections[index] = { ...(receiptCollections[index] ?? delta), undoneAt };
      });
      collections.push(
        unrecorded
          ? { collectionId, outcome: "failed", message: unrecorded }
          : { collectionId, outcome },
      );
    }
    return { sources, collections, ...(conflicts.length > 0 ? { conflicts } : {}) };
  });
}
