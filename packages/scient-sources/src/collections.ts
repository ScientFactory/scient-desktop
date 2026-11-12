// @effect-diagnostics nodeBuiltinImport:off -- Collections share the source store's filesystem boundary.
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
  ScientSourceCollection,
  ScientSourceCollectionsDocument,
  ScientSourceSavedSearch,
  ScientSourcesBulkReceipt,
  SCIENT_SOURCE_COLLECTION_LIMIT,
  SCIENT_SOURCE_COLLECTION_MEMBER_LIMIT,
  SCIENT_SOURCE_SAVED_SEARCH_LIMIT,
  type ScientSourceFilter,
  type ScientSourcesBulkFields,
  type ScientSourcesBulkRequestChange,
  type ScientSourcesBulkResult,
  type ScientSourcesOrganization,
  type ScientSourcesOrganizeAction,
  type ScientSourcesOrganizeResult,
} from "./organize.ts";
import type { ScientSourceStoreLocation } from "./libraryRoot.ts";
import { assertScientProjectDirectory } from "./projectFiles.ts";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  SCIENT_SOURCES_DIRECTORY,
  scientSourceStoreInternals,
  updateScientSourcesMetadata,
} from "./store.ts";

export const SCIENT_SOURCE_COLLECTIONS_FILE = `${SCIENT_SOURCES_DIRECTORY}/collections.json`;
/** In the library each collection is its own file, so two computers editing two never conflict. */
const LIBRARY_COLLECTIONS_DIRECTORY = "collections";
const LIBRARY_SAVED_SEARCHES_FILE = "saved-searches.json";
const MAX_BULK_RECEIPT_BYTES = 4 * 1024 * 1024;
// A Library-sized edit from the panel arrives in parts of 100, each with its own receipt.
const BULK_RECEIPT_LIMIT = 250;

const MAX_COLLECTIONS_BYTES = 8 * 1024 * 1024;
const DELETED_ENTRY_LIMIT = 50;
const {
  sourceStorePaths,
  snapshot,
  readBoundedJson,
  atomicWriteJson,
  withStoreLock,
  asLibraryWriter,
  assertSafeIdentifier,
} = scientSourceStoreInternals;
type StorePaths = Awaited<ReturnType<typeof sourceStorePaths>>;

const LibraryCollectionFile = Schema.Struct({
  ...ScientSourceCollection.fields,
  formatVersion: Schema.Literal(2),
});
const LibrarySavedSearchesFile = Schema.Struct({
  formatVersion: Schema.Literal(2),
  savedSearches: Schema.Array(ScientSourceSavedSearch),
});
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

async function readDocument(paths: StorePaths): Promise<ScientSourceCollectionsDocument> {
  if (paths.owner.kind === "library") return readLibraryDocument(paths);
  const filePath = NodePath.join(paths.root, SCIENT_SOURCE_COLLECTIONS_FILE);
  const state = await snapshot(filePath);
  if (state === "missing") return EMPTY_DOCUMENT;
  if (state !== "file") throw new Error("collections.json is not a safe regular file.");
  return readBoundedJson(filePath, MAX_COLLECTIONS_BYTES, ScientSourceCollectionsDocument);
}

function libraryCollectionPath(paths: StorePaths, collectionId: string): string {
  assertSafeIdentifier(collectionId, "Collection ID");
  return NodePath.join(paths.base, LIBRARY_COLLECTIONS_DIRECTORY, `${collectionId}.json`);
}

/** The library's collection files and saved searches, read as one document. */
async function readLibraryDocument(paths: StorePaths): Promise<ScientSourceCollectionsDocument> {
  const directory = NodePath.join(paths.base, LIBRARY_COLLECTIONS_DIRECTORY);
  const collections: ScientSourceCollection[] = [];
  const state = await snapshot(directory);
  if (state !== "missing" && state !== "directory") {
    throw new Error("The collections folder is not a safe directory.");
  }
  if (state === "directory") {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile()) throw new Error(`Collection ${entry.name} is not a safe regular file.`);
      const { formatVersion: _formatVersion, ...collection } = await readBoundedJson(
        NodePath.join(directory, entry.name),
        MAX_COLLECTIONS_BYTES,
        LibraryCollectionFile,
      );
      if (`${collection.collectionId}.json` !== entry.name) {
        throw new Error(`Collection ${entry.name} does not match its file name.`);
      }
      collections.push(collection);
    }
  }
  const searchesPath = NodePath.join(paths.base, LIBRARY_SAVED_SEARCHES_FILE);
  const searchesState = await snapshot(searchesPath);
  if (searchesState !== "missing" && searchesState !== "file") {
    throw new Error(`${LIBRARY_SAVED_SEARCHES_FILE} is not a safe regular file.`);
  }
  const savedSearches =
    searchesState === "file"
      ? (await readBoundedJson(searchesPath, MAX_COLLECTIONS_BYTES, LibrarySavedSearchesFile))
          .savedSearches
      : [];
  return {
    formatVersion: 1,
    collections: collections.toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.collectionId.localeCompare(right.collectionId),
    ),
    savedSearches,
  };
}

/** Writes only the collection files that changed, then removes the ones no longer kept. */
async function writeLibraryDocument(
  paths: StorePaths,
  previous: ScientSourceCollectionsDocument,
  next: ScientSourceCollectionsDocument,
): Promise<void> {
  const before = new Map(
    previous.collections.map((collection) => [collection.collectionId, collection]),
  );
  for (const collection of next.collections) {
    if (JSON.stringify(before.get(collection.collectionId)) === JSON.stringify(collection))
      continue;
    await atomicWriteJson(
      libraryCollectionPath(paths, collection.collectionId),
      { formatVersion: 2, ...collection },
      MAX_COLLECTIONS_BYTES,
    );
  }
  if (JSON.stringify(previous.savedSearches) !== JSON.stringify(next.savedSearches)) {
    await atomicWriteJson(
      NodePath.join(paths.base, LIBRARY_SAVED_SEARCHES_FILE),
      { formatVersion: 2, savedSearches: next.savedSearches },
      MAX_COLLECTIONS_BYTES,
    );
  }
  const kept = new Set(next.collections.map((collection) => collection.collectionId));
  for (const collectionId of before.keys()) {
    if (!kept.has(collectionId)) {
      await NodeFSP.rm(libraryCollectionPath(paths, collectionId), { force: true });
    }
  }
}

/** For library merges: rewrites library collections under the collections lock, listing no records. */
function rewriteLibraryCollections<A>(
  paths: StorePaths,
  change: (
    collections: ReadonlyArray<ScientSourceCollection>,
    now: string,
  ) => { readonly collections: ReadonlyArray<ScientSourceCollection>; readonly result: A },
  /** Runs once the change is known and before any collection file is written. */
  beforeWrite?: (result: A) => Promise<void>,
): Promise<A> {
  if (paths.owner.kind !== "library") throw new Error("Only a library merges sources.");
  return withStoreLock(paths, "collections-write", async () => {
    const document = await readDocument(paths);
    const { collections, result } = change(document.collections, new Date().toISOString());
    const next: ScientSourceCollectionsDocument = { ...document, collections: [...collections] };
    validateCollectionsDocument(next);
    await beforeWrite?.(result);
    await writeLibraryDocument(paths, document, next);
    return result;
  });
}

/** For the move: rewrites the library's collections and saved searches in one locked change. */
function rewriteLibraryOrganization(
  paths: StorePaths,
  change: (document: ScientSourceCollectionsDocument) => ScientSourceCollectionsDocument,
): Promise<void> {
  if (paths.owner.kind !== "library") throw new Error("Only a library takes in collections.");
  return withStoreLock(paths, "collections-write", async () => {
    const document = await readDocument(paths);
    const next = validateCollectionsDocument(change(document));
    await writeLibraryDocument(paths, document, next);
  });
}

export const scientSourceCollectionsInternals = {
  rewriteLibraryCollections,
  rewriteLibraryOrganization,
};

function collectionsLabel(paths: StorePaths): string {
  return paths.owner.kind === "library"
    ? `${LIBRARY_COLLECTIONS_DIRECTORY}/ or ${LIBRARY_SAVED_SEARCHES_FILE}`
    : SCIENT_SOURCE_COLLECTIONS_FILE;
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
  root: ScientSourceStoreLocation,
  presentSourceIds?: ReadonlySet<string>,
): Promise<ScientSourcesOrganization> {
  const paths = await sourceStorePaths(root);
  const present =
    presentSourceIds ??
    new Set((await listScientSourceRecords(paths.location)).map((record) => record.sourceId));
  try {
    return projectOrganization(await readDocument(paths), present);
  } catch {
    return {
      collections: [],
      savedSearches: [],
      issue: `${collectionsLabel(paths)} could not be read. Collections and saved searches are hidden until it is fixed.`,
    };
  }
}

async function mutate<A>(
  root: ScientSourceStoreLocation,
  change: (
    document: ScientSourceCollectionsDocument,
    context: { readonly now: string; readonly presentSourceIds: ReadonlySet<string> },
  ) => { readonly document: ScientSourceCollectionsDocument | null; readonly result: A },
  beforeWrite?: (result: A) => Promise<void>,
): Promise<A> {
  const paths = await sourceStorePaths(root);
  return withStoreLock(paths, "collections-write", async () => {
    const document = await readDocument(paths);
    const presentSourceIds = new Set(
      (await listScientSourceRecords(paths.location)).map((record) => record.sourceId),
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
      if (paths.owner.kind === "library") {
        await writeLibraryDocument(paths, document, bounded);
      } else {
        await atomicWriteJson(
          NodePath.join(paths.root, SCIENT_SOURCE_COLLECTIONS_FILE),
          bounded,
          MAX_COLLECTIONS_BYTES,
        );
      }
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
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
    // Its parent may have moved under another collection since; nesting stays one level deep.
    const parent = current.parentCollectionId
      ? findCollection(document, current.parentCollectionId)
      : undefined;
    const keepsParent = parent !== undefined && parent.parentCollectionId === undefined;
    const parentCollectionId = keepsParent ? current.parentCollectionId : undefined;
    const clash = liveCollectionByName(document, current.name, parentCollectionId);
    if (clash) return { document: null, result: { outcome: "name-taken", collection: clash } };
    const { deletedAt: _deletedAt, parentCollectionId: _parent, ...live } = current;
    const collection: ScientSourceCollection = {
      ...live,
      ...(parentCollectionId ? { parentCollectionId } : {}),
      updatedAt: now,
      updatedBy: input.actor,
    };
    return {
      document: replaceCollection(document, collection),
      result: { outcome: "restored", collection, ...unchangedMembers },
    };
  });
}

export function changeScientSourceCollectionMembers(input: {
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
  readonly change: ScientSourcesOrganizeAction;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourcesOrganizeResult> {
  const { root, change, actor } = input;
  const collectionResult = async (pending: Promise<ScientSourceCollectionChange>) => {
    const result = await pending;
    if (!result.collection) return { outcome: result.outcome };
    const present = new Set((await listScientSourceRecords(root)).map((record) => record.sourceId));
    const live = new Set(liveCollectionIds(await readDocument(await sourceStorePaths(root))));
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

interface BulkFieldsUpdate {
  readonly entry: BulkSourceResult;
  readonly change?: { readonly before: BulkFields; readonly after: BulkFields };
  readonly conflicts: ReadonlyArray<string>;
  readonly uncertain?: true;
}

interface PlannedBulkFields {
  readonly sourceId: string;
  readonly before: BulkFields;
  readonly after: BulkFields;
  readonly revision: number;
}

/**
 * Rewrites each source's tags and type from its current values, retrying once those that change
 * meanwhile. `beforeWrite` runs once per round with every write it plans; if it fails, none is
 * written. `uncertain` means the write failed part way, so it may have landed.
 */
async function updateBulkFields(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceIds: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
  readonly compute: (
    sourceId: string,
    current: BulkFields,
  ) => { readonly next: BulkFields; readonly conflicts?: ReadonlyArray<string> };
  readonly beforeWrite?: (planned: ReadonlyArray<PlannedBulkFields>) => Promise<void>;
}): Promise<ReadonlyArray<BulkFieldsUpdate>> {
  const results = new Map<string, BulkFieldsUpdate>();
  let remaining = input.sourceIds;
  // One retry covers an edit that lands between the read and the write.
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
    const planned: Array<
      PlannedBulkFields & {
        readonly metadata: ScientSourceEditableMetadata;
        readonly conflicts: ReadonlyArray<string>;
      }
    > = [];
    for (const sourceId of remaining) {
      const record = await readScientSourceRecord(input.root, sourceId);
      if (!record) {
        results.set(sourceId, {
          entry: { sourceId, outcome: "not-found", revision: null },
          conflicts: [],
        });
        continue;
      }
      const current = normalizeScientSourceEditableMetadata(editableMetadataFromRecord(record));
      const { next: fields, conflicts = [] } = input.compute(sourceId, bulkFields(current));
      const next = normalizeScientSourceEditableMetadata({ ...current, ...fields });
      if (editableMetadataEquals(current, next)) {
        results.set(sourceId, {
          entry: { sourceId: record.sourceId, outcome: "unchanged", revision: record.revision },
          conflicts,
        });
        continue;
      }
      planned.push({
        sourceId: record.sourceId,
        before: bulkFields(current),
        after: bulkFields(next),
        revision: record.revision,
        metadata: next,
        conflicts,
      });
    }
    remaining = [];
    if (planned.length === 0) break;
    try {
      await input.beforeWrite?.(
        planned.map(({ sourceId, before, after, revision }) => ({
          sourceId,
          before,
          after,
          revision,
        })),
      );
    } catch (error) {
      for (const plan of planned) {
        results.set(plan.sourceId, {
          entry: {
            sourceId: plan.sourceId,
            outcome: "failed",
            revision: plan.revision,
            message: failureMessage(error, "Undo could not be saved."),
          },
          conflicts: plan.conflicts,
        });
      }
      break;
    }
    const written = await updateScientSourcesMetadata({
      root: input.root,
      updates: planned.map((plan) => ({
        sourceId: plan.sourceId,
        expectedRevision: plan.revision,
        metadata: plan.metadata,
        allowPossibleMetadataMatch: true,
        allowExistingValidationIssues: true,
        actor: input.actor,
      })),
    }).catch((error: unknown) =>
      planned.map((plan) => ({ outcome: "failed" as const, sourceId: plan.sourceId, error })),
    );
    const retry: string[] = [];
    for (const [index, plan] of planned.entries()) {
      const { sourceId, revision, conflicts } = plan;
      const result = written[index]!;
      if (result.outcome === "stale") {
        retry.push(sourceId);
        continue;
      }
      if (result.outcome === "failed") {
        results.set(sourceId, {
          entry: {
            sourceId,
            outcome: "failed",
            revision,
            message:
              result.error instanceof Error
                ? result.error.message
                : "The source could not be updated.",
          },
          conflicts,
          uncertain: true,
        });
        continue;
      }
      if (result.outcome === "duplicate") {
        results.set(sourceId, {
          entry: { sourceId, outcome: "failed", revision, message: result.duplicate.reason },
          conflicts,
        });
        continue;
      }
      const updated = result.outcome === "updated";
      results.set(sourceId, {
        entry: {
          sourceId,
          outcome: updated ? "updated" : "unchanged",
          revision: result.record.revision,
        },
        ...(updated
          ? {
              change: {
                before: plan.before,
                after: bulkFields(
                  normalizeScientSourceEditableMetadata(editableMetadataFromRecord(result.record)),
                ),
              },
            }
          : {}),
        conflicts,
      });
    }
    remaining = retry;
  }
  for (const sourceId of remaining) {
    results.set(sourceId, {
      entry: {
        sourceId,
        outcome: "failed",
        revision: null,
        message: "The source kept changing while it was updated. Try again.",
      },
      conflicts: [],
    });
  }
  return input.sourceIds.map((sourceId) => results.get(sourceId)!);
}

function bulkEditsDirectory(paths: StorePaths): string {
  return NodePath.join(paths.base, "bulk-edits");
}

function bulkReceiptPath(paths: StorePaths, batchId: string): string {
  return NodePath.join(bulkEditsDirectory(paths), `${batchId}.json`);
}

/** A project folder is checked for links on the way; the library folder is Scient's own. */
async function assertBulkEditsDirectory(paths: StorePaths, create: boolean): Promise<void> {
  const directory = bulkEditsDirectory(paths);
  if (paths.owner.kind === "project") {
    await assertScientProjectDirectory(paths.root, directory, create ? { create } : undefined);
    return;
  }
  if (create) await NodeFSP.mkdir(directory, { recursive: true });
  const state = await snapshot(directory);
  if (state === "missing") throw Object.assign(new Error("No bulk edits."), { code: "ENOENT" });
  if (state !== "directory") throw new Error("The bulk edits folder is not a safe directory.");
}

async function writeBulkReceipt(
  paths: StorePaths,
  receipt: ScientSourcesBulkReceipt,
  options: { readonly prune?: boolean } = {},
): Promise<void> {
  const directory = bulkEditsDirectory(paths);
  await asLibraryWriter(paths, async () => {
    await assertBulkEditsDirectory(paths, true);
    await atomicWriteJson(
      bulkReceiptPath(paths, receipt.batchId),
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
  });
}

async function readBulkReceipt(
  paths: StorePaths,
  batchId: string,
): Promise<ScientSourcesBulkReceipt | null> {
  assertSafeIdentifier(batchId, "Bulk edit ID");
  try {
    await assertBulkEditsDirectory(paths, false);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const filePath = bulkReceiptPath(paths, batchId);
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
  readonly root: ScientSourceStoreLocation;
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
      paths,
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
    if (!editsRecords) {
      for (const sourceId of sourceIds) {
        const existing = await readScientSourceRecord(paths.location, sourceId);
        sources.push(
          existing
            ? { sourceId, outcome: "unchanged", revision: existing.revision }
            : { sourceId, outcome: "not-found", revision: null },
        );
      }
    } else {
      const intents = new Map<string, BulkReceiptSource>();
      const updates = await updateBulkFields({
        root: paths.location,
        sourceIds,
        actor: input.actor,
        compute: (_sourceId, current) => ({
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
          const entries = planned.map((change): BulkReceiptSource => ({
            sourceId: change.sourceId,
            before: change.before,
            after: change.after,
            revision: change.revision,
            pending: true,
          }));
          return writeAhead(
            () => {
              for (const entry of entries) {
                const previous = intents.get(entry.sourceId);
                if (previous) replaceEntry(receiptSources, previous);
                receiptSources.push(entry);
                intents.set(entry.sourceId, entry);
              }
            },
            () => {
              for (const entry of entries) {
                replaceEntry(receiptSources, entry);
                intents.delete(entry.sourceId);
              }
            },
          );
        },
      });
      let finished = false;
      let settledOnly = false;
      for (const updated of updates) {
        const written = intents.get(updated.entry.sourceId);
        const entryChange = updated.change;
        if (written && entryChange) {
          replaceEntry(receiptSources, written, {
            sourceId: written.sourceId,
            ...entryChange,
            ...(written.revision === undefined ? {} : { revision: written.revision }),
          });
          finished = true;
        } else if (written && !updated.uncertain) {
          // Known not to have landed, so Undo has nothing to check.
          replaceEntry(receiptSources, written);
          settledOnly = true;
        }
      }
      const message = finished
        ? await finish(() => undefined)
        : settledOnly
          ? await publish().then(
              () => undefined,
              () => undefined,
            )
          : undefined;
      let reported = false;
      for (const updated of updates) {
        const note = message && updated.change && !reported ? message : undefined;
        if (note) reported = true;
        sources.push(note ? { ...updated.entry, message: note } : updated.entry);
      }
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
          root: paths.location,
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
          root: paths.location,
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
      await asLibraryWriter(paths, () =>
        NodeFSP.rm(bulkReceiptPath(paths, batchId), { force: true }),
      ).catch(() => undefined);
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
  readonly root: ScientSourceStoreLocation;
  readonly batchId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourcesBulkResult> {
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, "bulk-undo", async () => {
    const receipt = await readBulkReceipt(paths, input.batchId);
    if (!receipt || receipt.undoneAt !== undefined) {
      return {
        sources: [],
        collections: [],
        conflicts: [
          {
            message: receipt
              ? "This bulk edit was already undone."
              : "This bulk edit was not found. Only the latest 250 can be undone.",
          },
        ],
      };
    }
    const receiptSources = [...receipt.sources];
    const receiptCollections = [...receipt.collections];
    const save = (undoneAt?: string) =>
      writeBulkReceipt(paths, {
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
    const open = [...receiptSources.entries()].filter(([, entry]) => entry.undoneAt === undefined);
    const known = new Map<number, Awaited<ReturnType<typeof updateBulkFields>>[number]>();
    const toWrite: Array<readonly [number, BulkReceiptSource]> = [];
    for (const [index, entry] of open) {
      const record = await readScientSourceRecord(paths.location, entry.sourceId);
      const settled = record
        ? settledSource(
            entry,
            record.revision,
            bulkFields(normalizeScientSourceEditableMetadata(editableMetadataFromRecord(record))),
          )
        : null;
      if (settled && record) {
        known.set(index, {
          entry: { sourceId: entry.sourceId, outcome: "unchanged", revision: record.revision },
          conflicts: settled.conflict ? [settled.conflict] : [],
        });
      } else {
        toWrite.push([index, entry]);
      }
    }
    const indexBySource = new Map(toWrite.map(([index, entry]) => [entry.sourceId, index]));
    const restored = await updateBulkFields({
      root: paths.location,
      sourceIds: toWrite.map(([, entry]) => entry.sourceId),
      actor: input.actor,
      compute: (sourceId, current) => {
        const { before, after } = receipt.sources[indexBySource.get(sourceId)!]!;
        const typeChanged = before.type !== after.type || before.customType !== after.customType;
        const beforeKeys = new Set(before.tags.map(scientSourceTagKey));
        const afterKeys = new Set(after.tags.map(scientSourceTagKey));
        const added = after.tags.filter((tag) => !beforeKeys.has(scientSourceTagKey(tag)));
        const removed = before.tags.filter((tag) => !afterKeys.has(scientSourceTagKey(tag)));
        const isType = (fields: BulkFields) =>
          current.type === fields.type && current.customType === fields.customType;
        const typeKept = typeChanged && !isType(after) && !isType(before);
        return {
          next: {
            type: typeChanged && isType(after) ? before.type : current.type,
            customType: typeChanged && isType(after) ? before.customType : current.customType,
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
      beforeWrite: (planned) =>
        intend(() => {
          for (const change of planned) {
            const index = indexBySource.get(change.sourceId)!;
            receiptSources[index] = {
              ...receipt.sources[index]!,
              restoring: { revision: change.revision, fields: change.after },
            };
          }
        }),
    });
    for (const [position, [index]] of toWrite.entries()) known.set(index, restored[position]!);
    const conflicts: BulkConflict[] = [];
    const outcomes: Array<{
      readonly index: number;
      readonly entry: BulkSourceResult;
      readonly done: boolean;
    }> = [];
    for (const [index, entry] of open) {
      const { sourceId } = entry;
      const result = known.get(index)!;
      if (result.entry.outcome === "failed") {
        outcomes.push({ index, entry: result.entry, done: false });
        continue;
      }
      if (unsaved !== null) {
        outcomes.push({
          index,
          entry: { sourceId, outcome: "failed", revision: null, message: unsaved },
          done: false,
        });
        continue;
      }
      if (result.entry.outcome === "not-found") {
        conflicts.push({ sourceId, message: "The source is no longer in the Library." });
      }
      for (const message of result.conflicts) conflicts.push({ sourceId, message });
      outcomes.push({ index, entry: result.entry, done: true });
    }
    const unrecorded = outcomes.some((outcome) => outcome.done)
      ? await markDone((undoneAt) => {
          for (const { index, done } of outcomes) {
            if (done) receiptSources[index] = { ...receiptSources[index]!, undoneAt };
          }
        })
      : undefined;
    const sources = outcomes.map(({ entry, done }) =>
      done && unrecorded ? { ...entry, outcome: "failed" as const, message: unrecorded } : entry,
    );
    const collections: BulkCollectionResult[] = [];
    for (const [index, delta] of [...receiptCollections.entries()].toReversed()) {
      if (delta.undoneAt !== undefined) continue;
      const { collectionId } = delta;
      if (unsaved !== null) {
        collections.push({ collectionId, outcome: "failed", message: unsaved });
        continue;
      }
      const document = await readDocument(paths).catch(() => null);
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
                root: paths.location,
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
            root: paths.location,
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
