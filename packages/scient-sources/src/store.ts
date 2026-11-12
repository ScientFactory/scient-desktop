// @effect-diagnostics nodeBuiltinImport:off -- The store is Scient's explicit project and library filesystem boundary.
// @effect-diagnostics globalDate:off -- Portable records and receipts use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { inspectScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { BibliographyImportReport } from "./bibliography/index.ts";
import {
  assessSourceDuplicate,
  assessSourceMetadataDuplicate,
  sourceMetadataMatchIndex,
} from "./duplicates.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  isScientLibraryLocation,
  readScientLibraryManifest,
  scientLibraryLocation,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "./libraryRoot.ts";
import { resolveScientProjectFile } from "./projectFiles.ts";
import {
  assertSafeIdentifier,
  atomicCreateJson,
  atomicWriteJson,
  ensureDirectory,
  isNodeError,
  readBoundedJson,
  snapshot,
} from "./storeFiles.ts";
import { abstractDocumentFromSections, normalizeScientSourceAbstractDocument } from "./abstract.ts";
import {
  assignCitationKey,
  citationKeyComparisonValue,
  citationKeyValidationMessage,
  takenCitationKeys,
  uniqueCitationKey,
} from "./citationKeys.ts";
import {
  applyEditableMetadata,
  changedEditableMetadataFields,
  editableMetadataEquals,
  editableMetadataFromRecord,
  normalizeScientSourceEditableMetadata,
  validateScientSourceEditableMetadata,
} from "./editable.ts";
import {
  type ScientLibraryRecord,
  ScientLibraryRecordV2,
  scientSourceReadingState,
  type ScientSourceReadingState,
  type ScientSourceReadingStatus,
  ScientSourceImportOperation,
  ScientSourceImportReceipt,
  ScientSourceRecordV1,
  type ScientSourceRecord,
  ScientSourceStagedMaterial,
  ScientSourceZoteroSync,
  SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  type ScientSourceActor,
  type ScientSourceAttachment,
  type ScientSourceAttachmentRetrieval,
  ScientSourceCandidate,
  type ScientSourceDuplicateAssessment,
  type ScientSourceDuplicateKind,
  type ScientSourceEditableMetadata,
  type ScientSourceExternalReference,
  type ScientSourceFieldProvenance,
  type ScientSourceMetadataUpdateResult,
  type ScientSourceNoteUpdateResult,
  type ScientSourceOrigin,
  type ScientSourceStagedMaterial as ScientSourceStagedMaterialType,
  type ScientSourcePermanentDeletionResult,
  type ScientSourceRemovalResult,
  type ScientSourceRestoreResult,
  type ScientSourceRevertResult,
  type ScientSourceRevisionSummary,
  type ScientSourcesOverview,
  type ScientSourceStoreIssue,
  type ScientSourceTrashListing,
  type ScientSourceVerification,
  type ScientSourceEditorialStatus,
  type ScientSourceZoteroSync as ScientSourceZoteroSyncType,
  ScientSourceTrashEntry,
} from "./model.ts";

export const SCIENT_SOURCES_DIRECTORY = ".scient/sources";
export const SCIENT_SOURCE_RECORDS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/records`;
export const SCIENT_SOURCE_FILES_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/files/sha256`;
export const SCIENT_SOURCE_HISTORY_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/history`;
export const SCIENT_SOURCE_OPERATIONS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/operations`;
export const SCIENT_SOURCE_RECEIPTS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/receipts`;
/** Kept revisions per source, counting the first one, which is never pruned. */
export const SCIENT_SOURCE_HISTORY_LIMIT = 50;
/** In the library, Zotero merge bases sit at `zotero/`; every other folder keeps its project name. */
const SCIENT_LIBRARY_ZOTERO_SYNC_DIRECTORY = "zotero";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_TRASH_ENTRY_BYTES = MAX_RECORD_BYTES + 64 * 1024;
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_STAGED_MATERIAL_BYTES = 2 * 1024 * 1024;
const operationLocks = new Map<string, Promise<unknown>>();
const activeOperationIds = new Map<string, string>();
const operationRecordSnapshots = new Map<
  string,
  {
    readonly fingerprint: string;
    readonly records: ReadonlyArray<ScientSourceRecord>;
  }
>();
const decodeScientSourceRecordV1 = Schema.decodeUnknownSync(ScientSourceRecordV1);
const decodeScientLibraryRecordV2 = Schema.decodeUnknownSync(ScientLibraryRecordV2);
const decodeScientSourceStagedMaterial = Schema.decodeUnknownSync(ScientSourceStagedMaterial);
const decodeScientSourceTrashEntry = Schema.decodeUnknownSync(ScientSourceTrashEntry);
const PersistedScientSourceImportOperation = Schema.Struct({
  ...ScientSourceImportOperation.fields,
  // Operations written before local-file imports existed did not record an adapter.
  adapter: Schema.optionalKey(ScientSourceImportOperation.fields.adapter),
  actor: Schema.optionalKey(ScientSourceImportOperation.fields.actor),
  intake: Schema.optionalKey(ScientSourceImportOperation.fields.intake),
});

export interface ImportedSourceResult {
  readonly outcome: "imported" | "duplicate";
  readonly record: ScientSourceRecord | null;
  readonly duplicate: ScientSourceDuplicateAssessment;
}

function duplicateBlocksImport(
  duplicate: ScientSourceDuplicateAssessment,
  allowPossibleMetadataMatch: boolean,
): boolean {
  return (
    duplicate.kind !== "new" &&
    !(allowPossibleMetadataMatch && duplicate.kind === "possible-metadata-match")
  );
}

/** Central version boundary for durable source records. Add migrations here, never at callers. */
export function decodePersistedScientSourceRecord(value: unknown): ScientSourceRecord {
  if (!value || typeof value !== "object" || !("formatVersion" in value)) {
    throw new Error("The source record has no recognized format version.");
  }
  const version = (value as { readonly formatVersion?: unknown }).formatVersion;
  switch (version) {
    case 1:
      return decodeScientSourceRecordV1(value);
    case 2:
      // Decoding drops unknown keys, so a project link must be refused before it would vanish.
      if ("projectId" in value) throw new Error("A library source record must not name a project.");
      return decodeScientLibraryRecordV2(value);
    default:
      throw new Error(`Source record format version ${String(version)} is not supported.`);
  }
}

async function readBoundedSourceRecord(filePath: string): Promise<ScientSourceRecord> {
  const value = await readBoundedJson(filePath, MAX_RECORD_BYTES, Schema.Unknown);
  return decodePersistedScientSourceRecord(value);
}

const recordChangeListeners = new Set<(root: string) => void>();

/** Called after every project source write settles, with the canonical project root. */
export function onScientSourceRecordsChanged(listener: (root: string) => void): () => void {
  recordChangeListeners.add(listener);
  return () => recordChangeListeners.delete(listener);
}

async function withOperationLock<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = operationLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  operationLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (operationLocks.get(key) === tail) operationLocks.delete(key);
  }
}

/**
 * The write lock for one kind of store change. In the library it sits inside the cross-process
 * library lock, taken first so a holder's nested changes never wait on a process-local key that
 * a waiter for the library lock holds.
 */
async function withStoreLock<A>(
  paths: SourceStorePaths,
  scope: string,
  run: () => Promise<A>,
): Promise<A> {
  const key = `${paths.root}:${scope}`;
  if (paths.owner.kind === "library") {
    return withScientLibraryLock(paths.root, () => withOperationLock(key, run));
  }
  try {
    return await withOperationLock(key, run);
  } finally {
    if (scope === "source-write") {
      for (const listener of recordChangeListeners) listener(paths.root);
    }
  }
}

/** A library write outside the store's operation locks still holds the library lock. */
function asLibraryWriter<A>(paths: SourceStorePaths, run: () => Promise<A>): Promise<A> {
  return paths.owner.kind === "library" ? withScientLibraryLock(paths.root, run) : run();
}

export async function canonicalizeScientSourceRoot(root: string): Promise<string> {
  return NodeFSP.realpath(root);
}

type SourceStoreOwner =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "library"; readonly libraryId: string };

interface SourceStorePaths {
  /** The canonical location, to hand to other store functions. */
  readonly location: ScientSourceStoreLocation;
  readonly root: string;
  /** The folder attachment and staging paths are relative to. */
  readonly base: string;
  readonly owner: SourceStoreOwner;
  readonly records: string;
  readonly files: string;
  readonly history: string;
  readonly operations: string;
  readonly receipts: string;
  readonly staging: string;
  readonly trash: string;
  readonly zotero: string;
}

function storeFolders(base: string, zotero: string) {
  return {
    base,
    records: NodePath.join(base, "records"),
    files: NodePath.join(base, "files", "sha256"),
    history: NodePath.join(base, "history"),
    operations: NodePath.join(base, "operations"),
    receipts: NodePath.join(base, "receipts"),
    staging: NodePath.join(base, "staging"),
    trash: NodePath.join(base, "trash"),
    zotero: NodePath.join(base, zotero),
  };
}

async function sourceStorePaths(location: ScientSourceStoreLocation): Promise<SourceStorePaths> {
  if (isScientLibraryLocation(location)) {
    const root = await canonicalizeScientSourceRoot(location.root);
    const { libraryId } = await readScientLibraryManifest(root);
    return {
      location: scientLibraryLocation(root),
      root,
      owner: { kind: "library", libraryId },
      ...storeFolders(root, SCIENT_LIBRARY_ZOTERO_SYNC_DIRECTORY),
    };
  }
  const root = await canonicalizeScientSourceRoot(location);
  const { projectId } = await readScientProjectIdentity(root);
  return {
    location: root,
    root,
    owner: { kind: "project", projectId },
    ...storeFolders(NodePath.join(root, SCIENT_SOURCES_DIRECTORY), NodePath.join("sync", "zotero")),
  };
}

/** The ID new source IDs are derived from: the project's, or the library's. */
function storeOwnerId(paths: SourceStorePaths): string {
  return paths.owner.kind === "project" ? paths.owner.projectId : paths.owner.libraryId;
}

/** Project stores hold format 1 files that name the project; the library holds format 2 files. */
function storeFormatVersion(paths: SourceStorePaths): 1 | 2 {
  return paths.owner.kind === "project" ? 1 : 2;
}

function projectField(paths: SourceStorePaths): { readonly projectId?: string } {
  return paths.owner.kind === "project" ? { projectId: paths.owner.projectId } : {};
}

/** Reading state lives on library records only; project records never carry it. */
function readingStateField(
  paths: SourceStorePaths,
): Pick<ScientLibraryRecord, "readingStatus" | "starred"> | Record<never, never> {
  return paths.owner.kind === "library" ? { readingStatus: "unread", starred: false } : {};
}

function storeOwnerField(
  paths: SourceStorePaths,
): { readonly projectId: string } | { readonly libraryId: string } {
  return paths.owner.kind === "project"
    ? { projectId: paths.owner.projectId }
    : { libraryId: paths.owner.libraryId };
}

function recordBelongsToStore(paths: SourceStorePaths, record: ScientSourceRecord): boolean {
  return paths.owner.kind === "project"
    ? record.formatVersion === 1 && record.projectId === paths.owner.projectId
    : record.formatVersion === 2 && record.projectId === undefined;
}

function storeOwnerMessage(paths: SourceStorePaths, subject: string): string {
  return paths.owner.kind === "project"
    ? `${subject} belongs to another Scient project.`
    : `${subject} is not a library file.`;
}

function operationBelongsToStore(
  paths: SourceStorePaths,
  operation: {
    readonly formatVersion: 1 | 2;
    readonly projectId?: string;
    readonly libraryId?: string;
  },
): boolean {
  return paths.owner.kind === "project"
    ? operation.formatVersion === 1 && operation.projectId === paths.owner.projectId
    : operation.formatVersion === 2 && operation.libraryId === paths.owner.libraryId;
}

function projectRelativePath(paths: SourceStorePaths, filePath: string): string {
  return NodePath.relative(paths.root, filePath).split(NodePath.sep).join("/");
}

/** Symlinks and other non-regular entries are reported, never followed. */
const UNSAFE_ENTRY_MESSAGE = "The entry is not a safe regular file.";

function issueMessage(error: unknown): string {
  return error instanceof SyntaxError
    ? "The file is not valid JSON."
    : error instanceof Error
      ? error.message.split("\n")[0]!.slice(0, 500)
      : "The file could not be read.";
}

function operationCacheKey(paths: SourceStorePaths, operationId: string): string {
  return `${paths.root}\0${operationId}`;
}

function clearOperationCaches(paths: SourceStorePaths, operationId: string): void {
  if (activeOperationIds.get(paths.root) === operationId) {
    activeOperationIds.delete(paths.root);
  }
  operationRecordSnapshots.delete(operationCacheKey(paths, operationId));
}

async function recordsDirectoryFingerprint(paths: SourceStorePaths): Promise<string> {
  try {
    const stats = await NodeFSP.lstat(paths.records, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("The Scient source record store is unsafe.");
    }
    return [stats.dev, stats.ino, stats.mtimeNs, stats.ctimeNs].join(":");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
}

function sourceRecordPath(paths: SourceStorePaths, sourceId: string) {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.records, `${sourceId}.json`);
}

async function readSourceRecordFromPaths(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ScientSourceRecord> {
  const record = await readBoundedSourceRecord(sourceRecordPath(paths, sourceId));
  if (!recordBelongsToStore(paths, record)) {
    throw new Error(storeOwnerMessage(paths, "The source record"));
  }
  if (record.sourceId !== sourceId) throw new Error("The source record identity is inconsistent.");
  return record;
}

/** Reads one source without scanning or decoding the rest of the project ledger. */
export async function readScientSourceRecord(
  root: ScientSourceStoreLocation,
  sourceId: string,
): Promise<ScientSourceRecord | null> {
  const paths = await sourceStorePaths(root);
  const filePath = sourceRecordPath(paths, sourceId);
  if ((await snapshot(filePath)) === "missing") return null;
  return readSourceRecordFromPaths(paths, sourceId);
}

function sourceHistoryPath(paths: SourceStorePaths, sourceId: string, revision: number) {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.history, sourceId, `${revision}.json`);
}

async function latestSourceHistoryRevision(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<number> {
  const directory = NodePath.dirname(sourceHistoryPath(paths, sourceId, 1));
  const state = await snapshot(directory);
  if (state === "missing") return 0;
  if (state !== "directory") throw new Error("The source revision history is unsafe.");

  let latestRevision = 0;
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const match = /^(\d+)\.json$/u.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile()) throw new Error(`Source history ${entry.name} is not a safe file.`);
    const revision = Number.parseInt(match[1]!, 10);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error(`Source history ${entry.name} has an invalid revision.`);
    }
    const record = await readBoundedSourceRecord(NodePath.join(directory, entry.name));
    if (
      !recordBelongsToStore(paths, record) ||
      record.sourceId !== sourceId ||
      record.revision !== revision
    ) {
      throw new Error(`Source history ${entry.name} has inconsistent identity.`);
    }
    latestRevision = Math.max(latestRevision, revision);
  }
  return latestRevision;
}

async function persistSourceRevision(
  paths: SourceStorePaths,
  current: ScientSourceRecord,
  next: ScientSourceRecord,
): Promise<void> {
  await preserveSourceRevision(paths, current);
  await atomicWriteJson(sourceRecordPath(paths, current.sourceId), next, MAX_RECORD_BYTES);
  await pruneSourceHistory(paths, current.sourceId);
}

async function sourceHistoryRevisions(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ReadonlyArray<number>> {
  const directory = NodePath.dirname(sourceHistoryPath(paths, sourceId, 1));
  if ((await snapshot(directory)) !== "directory") return [];
  return (await NodeFSP.readdir(directory, { withFileTypes: true }))
    .flatMap((entry) => {
      const match = /^(\d+)\.json$/u.exec(entry.name);
      return match && entry.isFile() ? [Number.parseInt(match[1]!, 10)] : [];
    })
    .filter((revision) => Number.isSafeInteger(revision) && revision > 0)
    .toSorted((left, right) => left - right);
}

/** Keeps the first revision and the most recent ones; the current record counts as one. */
async function pruneSourceHistory(paths: SourceStorePaths, sourceId: string): Promise<void> {
  const revisions = await sourceHistoryRevisions(paths, sourceId);
  const keptHistory = SCIENT_SOURCE_HISTORY_LIMIT - 1;
  if (revisions.length <= keptHistory) return;
  const [first, ...rest] = revisions;
  const pruned = rest.slice(0, revisions.length - keptHistory);
  for (const revision of pruned) {
    if (revision === first) continue;
    await NodeFSP.rm(sourceHistoryPath(paths, sourceId, revision), { force: true });
  }
}

interface MetadataUpdate {
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly metadata: ScientSourceEditableMetadata;
  readonly fieldProvenance?: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly allowPossibleMetadataMatch?: boolean;
  readonly allowExistingValidationIssues?: boolean;
  readonly actor?: ScientSourceActor;
}

/**
 * Caller holds the source-write lock. `duplicates` lists the other records the update could
 * duplicate; `others` every other record, read only when the citation key changes.
 */
async function applyMetadataUpdate(
  paths: SourceStorePaths,
  input: MetadataUpdate,
  lookup: {
    readonly duplicates: (
      source: ScientSourceEditableMetadata,
      sourceId: string,
    ) => Promise<ReadonlyArray<ScientSourceRecord>>;
    readonly others: (sourceId: string) => Promise<ReadonlyArray<ScientSourceRecord>>;
  },
): Promise<ScientSourceMetadataUpdateResult> {
  assertSafeIdentifier(input.sourceId, "Source ID");
  const normalized = normalizeScientSourceEditableMetadata(input.metadata);
  const validationIssues = validateScientSourceEditableMetadata(normalized);
  const current = await readSourceRecordFromPaths(paths, input.sourceId);
  const currentMetadata = normalizeScientSourceEditableMetadata(
    editableMetadataFromRecord(current),
  );
  const requested =
    normalized.citationKey === undefined && current.citationKey
      ? { citationKey: current.citationKey, ...normalized }
      : normalized;
  const existingValidationIssues = input.allowExistingValidationIssues
    ? validateScientSourceEditableMetadata(currentMetadata)
    : [];
  const introducedValidationIssues = validationIssues.filter(
    (issue) =>
      !existingValidationIssues.some(
        (existing) => existing.field === issue.field && existing.message === issue.message,
      ),
  );
  if (introducedValidationIssues.length > 0) {
    throw new Error(introducedValidationIssues.map((issue) => issue.message).join(" "));
  }
  const duplicate = assessSourceMetadataDuplicate({
    source: requested,
    existing: await lookup.duplicates(requested, current.sourceId),
  });

  // A client that lost the successful response may retry with the old revision.
  if (editableMetadataEquals(currentMetadata, requested)) {
    return { outcome: "unchanged", record: current, duplicate, validationIssues };
  }
  if (current.revision !== input.expectedRevision) {
    return { outcome: "stale", record: current, duplicate, validationIssues };
  }
  if (
    duplicate.kind === "same-identifier" ||
    (duplicate.kind === "possible-metadata-match" && !input.allowPossibleMetadataMatch)
  ) {
    return { outcome: "duplicate", record: current, duplicate, validationIssues };
  }

  if (
    requested.citationKey !== undefined &&
    citationKeyComparisonValue(requested.citationKey) !==
      citationKeyComparisonValue(current.citationKey ?? "")
  ) {
    const message = citationKeyValidationMessage(
      requested.citationKey,
      takenCitationKeys(await lookup.others(current.sourceId)),
    );
    if (message) throw new Error(message);
  }

  const applied = applyEditableMetadata({
    record: current,
    metadata: requested,
    updatedAt: new Date().toISOString(),
    actor: input.actor ?? "user",
  });
  const identifiersChanged = changedEditableMetadataFields(currentMetadata, requested).includes(
    "identifiers",
  );
  const {
    verification: _staleVerification,
    editorialStatus: _staleEditorialStatus,
    ...unverified
  } = applied;
  // A verification or retraction check vouches only for the identifiers it checked.
  const updated = identifiersChanged ? unverified : applied;
  const next = input.fieldProvenance
    ? { ...updated, fieldProvenance: [...input.fieldProvenance] }
    : updated;
  await persistSourceRevision(paths, current, next);
  return { outcome: "updated", record: next, duplicate, validationIssues };
}

export async function updateScientSourceMetadata(
  input: MetadataUpdate & { readonly root: ScientSourceStoreLocation },
): Promise<ScientSourceMetadataUpdateResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    let existing: Promise<ReadonlyArray<ScientSourceRecord>> | undefined;
    const others = (sourceId: string) =>
      (existing ??= listScientSourceRecordsFromPaths(paths).then((records) =>
        records.filter((record) => record.sourceId !== sourceId),
      ));
    return applyMetadataUpdate(paths, input, { duplicates: (_, id) => others(id), others });
  });
}

export type ScientSourceMetadataBatchResult =
  | ScientSourceMetadataUpdateResult
  | { readonly outcome: "failed"; readonly sourceId: string; readonly error: unknown };

/**
 * Applies updates in order with each one's `updateScientSourceMetadata` outcome, under one lock
 * and one scan of the store: duplicates are looked up by identifier and title key, not by
 * reading every record per update. One that throws is reported and the rest still run.
 */
export async function updateScientSourcesMetadata(input: {
  readonly root: ScientSourceStoreLocation;
  readonly updates: ReadonlyArray<MetadataUpdate>;
}): Promise<ReadonlyArray<ScientSourceMetadataBatchResult>> {
  if (input.updates.length === 0) return [];
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, "source-write", async () => {
    const records = new Map(
      (await listScientSourceRecordsFromPaths(paths)).map((record) => [record.sourceId, record]),
    );
    const index = sourceMetadataMatchIndex([...records.values()]);
    const lookup = {
      duplicates: async (source: ScientSourceEditableMetadata, sourceId: string) =>
        index.candidates(source, sourceId),
      others: async (sourceId: string) =>
        [...records.values()].filter((record) => record.sourceId !== sourceId),
    };
    const results: ScientSourceMetadataBatchResult[] = [];
    for (const update of input.updates) {
      try {
        const result = await applyMetadataUpdate(paths, update, lookup);
        if (result.outcome === "updated") {
          records.set(result.record.sourceId, result.record);
          index.replace(result.record);
        }
        results.push(result);
      } catch (error) {
        results.push({ outcome: "failed", sourceId: update.sourceId, error });
      }
    }
    return results;
  });
}

/**
 * Gives every source written before citation keys existed a generated key, oldest
 * first so earlier sources keep the unsuffixed key. Each assignment is a revision.
 */
export async function assignMissingScientSourceCitationKeys(
  root: ScientSourceStoreLocation,
): Promise<number> {
  const paths = await sourceStorePaths(root);
  return withStoreLock(paths, "source-write", async () => {
    const records = await listScientSourceRecordsFromPaths(paths);
    const missing = records
      .filter((record) => !record.citationKey)
      .toSorted(
        (left, right) =>
          left.importedAt.localeCompare(right.importedAt) ||
          left.sourceId.localeCompare(right.sourceId),
      );
    if (missing.length === 0) return 0;
    const taken = takenCitationKeys(records);
    const updatedAt = new Date().toISOString();
    for (const current of missing) {
      const citationKey = assignCitationKey({ ...current, taken });
      taken.add(citationKeyComparisonValue(citationKey));
      await persistSourceRevision(paths, current, {
        ...current,
        citationKey,
        revision: current.revision + 1,
        fieldProvenance: [
          ...current.fieldProvenance,
          { field: "citationKey", origin: "derived", sourceField: null },
        ],
        updatedAt,
      });
    }
    return missing.length;
  });
}

const withoutCheckTime = (value: {
  readonly verification?: ScientSourceVerification;
  readonly editorialStatus?: ScientSourceEditorialStatus;
}) =>
  JSON.stringify([
    value.verification ? { ...value.verification, checkedAt: null } : null,
    value.editorialStatus ? { ...value.editorialStatus, checkedAt: null } : null,
  ]);

/**
 * Records a fresh registry check of the source's identifier. A check that finds what the record
 * already says writes nothing, so repeated checks do not pile up revisions.
 */
export async function recordScientSourceCheck(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly verification: ScientSourceVerification;
  readonly editorialStatus: ScientSourceEditorialStatus | null;
  readonly actor?: ScientSourceActor;
}): Promise<{
  readonly outcome: "updated" | "unchanged" | "stale";
  readonly record: ScientSourceRecord;
}> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    if (current.revision !== input.expectedRevision) return { outcome: "stale", record: current };
    const { verification: _verification, editorialStatus: _editorial, ...rest } = current;
    const checked = {
      verification: input.verification,
      ...(input.editorialStatus ? { editorialStatus: input.editorialStatus } : {}),
    };
    if (withoutCheckTime(current) === withoutCheckTime(checked)) {
      return { outcome: "unchanged", record: current };
    }
    const next: ScientSourceRecord = {
      ...rest,
      ...checked,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    await persistSourceRevision(paths, current, next);
    return { outcome: "updated", record: next };
  });
}

function normalizeScientSourceNote(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.trim() ? normalized : null;
}

export async function updateScientSourceNote(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly note: string | null;
  readonly actor?: ScientSourceActor;
}): Promise<ScientSourceNoteUpdateResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  const note = normalizeScientSourceNote(input.note);

  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    if ((current.note ?? null) === note) {
      return { outcome: "unchanged", record: current };
    }
    if (current.revision !== input.expectedRevision) {
      return { outcome: "stale", record: current };
    }

    const next: ScientSourceRecord = {
      ...current,
      note,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    await persistSourceRevision(paths, current, next);
    return { outcome: "updated", record: next };
  });
}

export type ScientSourceReadingStateChange =
  | ({
      readonly sourceId: string;
      readonly outcome: "updated" | "unchanged";
    } & ScientSourceReadingState)
  | { readonly sourceId: string; readonly outcome: "not-found" };

/**
 * Marks library sources read or unread, starred or not. Reading state is about the person, so it
 * changes no revision and keeps no history: an editor open on the record is never made stale.
 */
export async function setScientLibraryReadingState(input: {
  readonly library: ScientLibraryLocation;
  readonly sourceIds: ReadonlyArray<string>;
  readonly readingStatus?: ScientSourceReadingStatus;
  readonly starred?: boolean;
}): Promise<ReadonlyArray<ScientSourceReadingStateChange>> {
  const paths = await sourceStorePaths(input.library);
  if (paths.owner.kind !== "library") throw new Error("Reading state lives in the Library.");
  for (const sourceId of input.sourceIds) assertSafeIdentifier(sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const changes: ScientSourceReadingStateChange[] = [];
    for (const sourceId of new Set(input.sourceIds)) {
      const current = await readScientSourceRecordIfPresent(paths, sourceId);
      const state = current ? scientSourceReadingState(current) : null;
      if (!current || !state) {
        changes.push({ sourceId, outcome: "not-found" });
        continue;
      }
      const next: ScientSourceReadingState = {
        readingStatus: input.readingStatus ?? state.readingStatus,
        starred: input.starred ?? state.starred,
      };
      const changed = next.readingStatus !== state.readingStatus || next.starred !== state.starred;
      if (changed) {
        await atomicWriteJson(
          sourceRecordPath(paths, sourceId),
          { ...current, ...next },
          MAX_RECORD_BYTES,
        );
      }
      changes.push({ sourceId, outcome: changed ? "updated" : "unchanged", ...next });
    }
    return changes;
  });
}

export async function removeScientSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly actor?: ScientSourceActor;
}): Promise<ScientSourceRemovalResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");

  return withStoreLock(paths, "source-write", async () => {
    const recordPath = sourceRecordPath(paths, input.sourceId);
    if ((await snapshot(recordPath)) === "missing") {
      return {
        outcome: "not-found",
        sourceId: input.sourceId,
        revision: null,
        removedAttachmentCount: 0,
        retainedAttachmentCount: 0,
      };
    }

    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    if (current.revision !== input.expectedRevision) {
      return {
        outcome: "stale",
        sourceId: current.sourceId,
        revision: current.revision,
        removedAttachmentCount: 0,
        retainedAttachmentCount: current.attachments.length,
      };
    }

    await moveRecordToTrash(paths, current, input.actor ?? "user");
    return {
      outcome: "removed",
      sourceId: current.sourceId,
      revision: current.revision,
      removedAttachmentCount: 0,
      retainedAttachmentCount: current.attachments.length,
      restorable: true,
    };
  });
}

/** Caller holds the source-write lock. */
async function moveRecordToTrash(
  paths: SourceStorePaths,
  current: ScientSourceRecord,
  removedBy: ScientSourceActor,
  mergedInto?: ScientSourceTrashEntry["mergedInto"],
): Promise<void> {
  await preserveSourceRevision(paths, current);
  const entry: ScientSourceTrashEntry = {
    formatVersion: storeFormatVersion(paths),
    sourceId: current.sourceId,
    ...projectField(paths),
    removedAt: new Date().toISOString(),
    removedBy,
    record: current,
    ...(mergedInto ? { mergedInto } : {}),
  };
  // The trash entry lands before the record goes: a crash in between leaves the source listed,
  // never lost. PDFs stay until the trash is emptied.
  await atomicWriteJson(trashEntryPath(paths, current.sourceId), entry, MAX_TRASH_ENTRY_BYTES);
  await NodeFSP.unlink(sourceRecordPath(paths, current.sourceId));
}

/**
 * Puts a trashed record back as a new revision; null when a live record already has its ID.
 * Caller holds the source-write lock.
 */
async function restoreTrashedRecord(
  paths: SourceStorePaths,
  entry: ScientSourceTrashEntry,
  existing: ReadonlyArray<ScientSourceRecord>,
  restoredBy: ScientSourceActor,
): Promise<ScientSourceRecord | null> {
  const { sourceId } = entry;
  await preserveSourceRevision(paths, entry.record);
  const revision = Math.max(
    entry.record.revision,
    await latestSourceHistoryRevision(paths, sourceId),
  );
  const restored: ScientSourceRecord = {
    ...entry.record,
    // Another source may have taken the key while this one was in the trash.
    ...(entry.record.citationKey
      ? { citationKey: uniqueCitationKey(entry.record.citationKey, takenCitationKeys(existing)) }
      : {}),
    revision: revision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: restoredBy,
  };
  if (!(await atomicCreateJson(sourceRecordPath(paths, sourceId), restored, MAX_RECORD_BYTES))) {
    return null;
  }
  await NodeFSP.rm(trashEntryPath(paths, sourceId), { force: true });
  await pruneSourceHistory(paths, sourceId);
  return restored;
}

function trashEntryPath(paths: SourceStorePaths, sourceId: string): string {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.trash, `${sourceId}.json`);
}

async function preserveSourceRevision(
  paths: SourceStorePaths,
  record: ScientSourceRecord,
): Promise<void> {
  const historyPath = sourceHistoryPath(paths, record.sourceId, record.revision);
  if (await atomicCreateJson(historyPath, record, MAX_RECORD_BYTES)) return;
  const history = await readBoundedSourceRecord(historyPath);
  if (JSON.stringify(history) !== JSON.stringify(record)) {
    throw new Error("The source revision history conflicts with the current record.");
  }
}

/** The entry schema would strip library-only record fields; the record decoder keeps them. */
function decodePersistedTrashEntry(value: unknown): ScientSourceTrashEntry {
  const entry = decodeScientSourceTrashEntry(value);
  const record =
    typeof value === "object" && value !== null && "record" in value ? value.record : null;
  return { ...entry, record: decodePersistedScientSourceRecord(record) };
}

async function readTrashEntry(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ScientSourceTrashEntry | null> {
  const filePath = trashEntryPath(paths, sourceId);
  if ((await snapshot(filePath)) === "missing") return null;
  const entry = decodePersistedTrashEntry(
    await readBoundedJson(filePath, MAX_TRASH_ENTRY_BYTES, Schema.Unknown),
  );
  if (
    entry.formatVersion !== storeFormatVersion(paths) ||
    entry.projectId !== projectField(paths).projectId ||
    !recordBelongsToStore(paths, entry.record)
  ) {
    throw new Error(storeOwnerMessage(paths, "The trashed source"));
  }
  if (entry.sourceId !== sourceId || entry.record.sourceId !== sourceId) {
    throw new Error("The trashed source identity is inconsistent.");
  }
  return entry;
}

async function scanTrash(paths: SourceStorePaths): Promise<{
  readonly entries: ReadonlyArray<ScientSourceTrashEntry>;
  readonly issues: ReadonlyArray<ScientSourceStoreIssue>;
}> {
  const state = await snapshot(paths.trash);
  if (state === "missing") return { entries: [], issues: [] };
  if (state !== "directory") throw new Error("The Scient source trash is unsafe.");
  const entries: ScientSourceTrashEntry[] = [];
  const issues: ScientSourceStoreIssue[] = [];
  for (const file of await NodeFSP.readdir(paths.trash, { withFileTypes: true })) {
    if (!file.name.endsWith(".json")) continue;
    const sourceId = file.name.slice(0, -".json".length);
    const filePath = NodePath.join(paths.trash, file.name);
    if (!file.isFile()) {
      issues.push({ path: projectRelativePath(paths, filePath), message: UNSAFE_ENTRY_MESSAGE });
      continue;
    }
    try {
      const entry = await readTrashEntry(paths, sourceId);
      // A live record with the same ID means a removal stopped before deleting it.
      if (entry && (await snapshot(sourceRecordPath(paths, sourceId))) === "missing") {
        entries.push(entry);
      }
    } catch (error) {
      issues.push({ path: projectRelativePath(paths, filePath), message: issueMessage(error) });
    }
  }
  return {
    entries: entries.toSorted((left, right) => right.removedAt.localeCompare(left.removedAt)),
    issues,
  };
}

/** Whole trashed records, newest removal first, for callers that need more than the summary. */
export async function readScientSourceTrashEntries(
  root: ScientSourceStoreLocation,
): Promise<ReadonlyArray<ScientSourceTrashEntry>> {
  return (await scanTrash(await sourceStorePaths(root))).entries;
}

export async function listScientSourceTrash(
  root: ScientSourceStoreLocation,
): Promise<ScientSourceTrashListing> {
  const { entries, issues } = await scanTrash(await sourceStorePaths(root));
  return {
    entries: entries.map(({ record, removedAt, removedBy }) => ({
      sourceId: record.sourceId,
      revision: record.revision,
      type: record.type,
      title: record.title,
      creators: record.creators,
      issuedYear: record.issuedYear,
      removedAt,
      removedBy,
    })),
    issues,
  };
}

/** Puts a trashed source back as a new revision credited to whoever restored it. */
export async function restoreScientSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly actor?: ScientSourceActor;
}): Promise<ScientSourceRestoreResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const empty = { sourceId: input.sourceId, record: null, matchingSourceIds: [] };
    const entry = await readTrashEntry(paths, input.sourceId);
    if (!entry) return { outcome: "not-found", ...empty };
    const recordPath = sourceRecordPath(paths, input.sourceId);
    if ((await snapshot(recordPath)) !== "missing") {
      return { ...empty, outcome: "exists", matchingSourceIds: [input.sourceId] };
    }
    // Restoring a merged source on its own would leave its alias pointing at the survivor.
    if (entry.mergedInto) {
      return { ...empty, outcome: "duplicate", matchingSourceIds: [entry.mergedInto.sourceId] };
    }
    const existing = await listScientSourceRecordsFromPaths(paths);
    const duplicate = assessSourceMetadataDuplicate({
      source: editableMetadataFromRecord(entry.record),
      existing,
    });
    if (duplicate.kind === "same-identifier") {
      return { ...empty, outcome: "duplicate", matchingSourceIds: duplicate.matchingSourceIds };
    }
    const restored = await restoreTrashedRecord(paths, entry, existing, input.actor ?? "user");
    if (!restored) return { ...empty, outcome: "exists", matchingSourceIds: [input.sourceId] };
    return {
      outcome: "restored",
      sourceId: input.sourceId,
      record: restored,
      matchingSourceIds: [],
    };
  });
}

/**
 * Deletes trashed sources for good: their entries, their revision history, and every stored PDF
 * no remaining source or trashed source refers to. Omitting sourceIds empties the whole trash.
 */
export async function deleteScientSourcesPermanently(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceIds?: ReadonlyArray<string>;
}): Promise<ScientSourcePermanentDeletionResult> {
  const paths = await sourceStorePaths(input.root);
  for (const sourceId of input.sourceIds ?? []) assertSafeIdentifier(sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const { entries } = await scanTrash(paths);
    const selected = input.sourceIds ? new Set(input.sourceIds) : null;
    return deleteTrashEntries(
      paths,
      entries.filter((entry) => !selected || selected.has(entry.sourceId)),
    );
  });
}

export type ScientTrashedSourceDeletionResult =
  | { readonly outcome: "deleted"; readonly sourceId: string; readonly removedFileCount: number }
  | { readonly outcome: "stale"; readonly sourceId: string; readonly revision: number }
  | { readonly outcome: "not-found"; readonly sourceId: string };

/**
 * Deletes one trashed source for good only if it is still the revision the caller saw. The
 * comparison runs under the same lock as the deletion, so a restore, edit and second removal in
 * between can never let an old request delete the newer record.
 */
export async function deleteTrashedScientSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
}): Promise<ScientTrashedSourceDeletionResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const entry = (await scanTrash(paths)).entries.find(
      (candidate) => candidate.sourceId === input.sourceId,
    );
    if (!entry) return { outcome: "not-found", sourceId: input.sourceId };
    if (entry.record.revision !== input.expectedRevision) {
      return { outcome: "stale", sourceId: input.sourceId, revision: entry.record.revision };
    }
    const { removedFileCount } = await deleteTrashEntries(paths, [entry]);
    return { outcome: "deleted", sourceId: input.sourceId, removedFileCount };
  });
}

/** Caller holds the source-write lock. */
async function deleteTrashEntries(
  paths: SourceStorePaths,
  entries: ReadonlyArray<ScientSourceTrashEntry>,
): Promise<ScientSourcePermanentDeletionResult> {
  for (const entry of entries) {
    await NodeFSP.rm(trashEntryPath(paths, entry.sourceId), { force: true });
    await NodeFSP.rm(NodePath.dirname(sourceHistoryPath(paths, entry.sourceId, 1)), {
      recursive: true,
      force: true,
    });
  }
  const removedFileCount = entries.length > 0 ? await collectUnreferencedSourceFiles(paths) : 0;
  return { deletedSourceIds: entries.map((entry) => entry.sourceId), removedFileCount };
}

/** Caller holds the source-write lock, so no import can be between staging a PDF and its record. */
async function collectUnreferencedSourceFiles(paths: SourceStorePaths): Promise<number> {
  const live = await scanScientSourceRecords(paths);
  const trash = await scanTrash(paths);
  // An unreadable record may still refer to a file; deleting nothing is the safe answer.
  if (live.issues.length > 0 || trash.issues.length > 0) return 0;
  const referenced = new Set(
    [...live.records, ...trash.entries.map((entry) => entry.record)].flatMap((record) =>
      record.attachments.map((attachment) => attachment.relativePath),
    ),
  );
  if ((await snapshot(paths.files)) !== "directory") return 0;
  let removed = 0;
  for (const prefix of await NodeFSP.readdir(paths.files, { withFileTypes: true })) {
    if (!prefix.isDirectory()) continue;
    const directory = NodePath.join(paths.files, prefix.name);
    for (const file of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.pdf$/u.test(file.name)) continue;
      if (referenced.has(NodePath.posix.join("files", "sha256", prefix.name, file.name))) continue;
      try {
        await NodeFSP.unlink(NodePath.join(directory, file.name));
        removed += 1;
      } catch {
        // A file that cannot be deleted now is collected the next time the trash is emptied.
      }
    }
    await NodeFSP.rmdir(directory).catch(() => undefined);
  }
  return removed;
}

// Reading state is about the person, not a revision of the source: never listed or reverted.
const REVERT_IGNORED_FIELDS = new Set([
  "revision",
  "updatedAt",
  "updatedBy",
  "readingStatus",
  "starred",
]);
const UNLISTED_CHANGE_FIELDS = new Set(["fieldProvenance"]);

/**
 * Fields that describe the source rather than one revision of it; reverting keeps them current.
 * The citation key stays because documents may already cite it.
 */
function revertPreservedFields(
  current: ScientSourceRecord,
): Pick<
  ScientSourceRecord,
  "formatVersion" | "sourceId" | "projectId" | "importedAt" | "origin" | "citationKey"
> &
  Partial<ScientSourceReadingState> {
  return {
    ...scientSourceReadingState(current),
    formatVersion: current.formatVersion,
    sourceId: current.sourceId,
    ...(current.projectId ? { projectId: current.projectId } : {}),
    importedAt: current.importedAt,
    ...(current.origin ? { origin: current.origin } : {}),
    ...(current.citationKey ? { citationKey: current.citationKey } : {}),
  };
}

function revisionContent(record: ScientSourceRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([field]) => !REVERT_IGNORED_FIELDS.has(field)),
  );
}

function changedRevisionFields(
  previous: ScientSourceRecord,
  next: ScientSourceRecord,
): ReadonlyArray<string> {
  const left = revisionContent(previous);
  const right = revisionContent(next);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))
    .toSorted();
}

async function readKeptRevisions(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  const kept: ScientSourceRecord[] = [];
  for (const revision of await sourceHistoryRevisions(paths, sourceId)) {
    try {
      const record = await readBoundedSourceRecord(sourceHistoryPath(paths, sourceId, revision));
      if (
        record.sourceId === sourceId &&
        recordBelongsToStore(paths, record) &&
        record.revision === revision
      ) {
        kept.push(record);
      }
    } catch {
      // An unreadable saved revision is simply not offered.
    }
  }
  return kept;
}

/** The kept revisions of a live source, newest first, including the current one. */
export async function listScientSourceRevisions(
  root: ScientSourceStoreLocation,
  sourceId: string,
): Promise<ReadonlyArray<ScientSourceRevisionSummary> | null> {
  const paths = await sourceStorePaths(root);
  const current = await readScientSourceRecordIfPresent(paths, sourceId);
  if (!current) return null;
  const records = [
    ...(await readKeptRevisions(paths, sourceId)).filter(
      (record) => record.revision < current.revision,
    ),
    current,
  ];
  return records
    .map((record, index) => ({
      revision: record.revision,
      savedAt: record.updatedAt ?? record.importedAt,
      savedBy: record.updatedBy ?? record.origin?.actor ?? "user",
      changes:
        index === 0
          ? []
          : changedRevisionFields(records[index - 1]!, record).filter(
              (field) => !UNLISTED_CHANGE_FIELDS.has(field),
            ),
      current: record.revision === current.revision,
    }))
    .toReversed();
}

async function readScientSourceRecordIfPresent(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ScientSourceRecord | null> {
  if ((await snapshot(sourceRecordPath(paths, sourceId))) === "missing") return null;
  return readSourceRecordFromPaths(paths, sourceId);
}

/**
 * Makes an earlier revision current again as a new revision. Attachments whose files were
 * deleted when the trash was emptied are left out and counted.
 */
export async function revertScientSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly toRevision: number;
  readonly actor?: ScientSourceActor;
}): Promise<ScientSourceRevertResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    const unchanged = { record: current, missingAttachmentCount: 0, matchingSourceIds: [] };
    if (current.revision !== input.expectedRevision) return { outcome: "stale", ...unchanged };
    if (input.toRevision === current.revision) return { outcome: "unchanged", ...unchanged };
    const historyPath = sourceHistoryPath(paths, input.sourceId, input.toRevision);
    if (
      !Number.isSafeInteger(input.toRevision) ||
      input.toRevision <= 0 ||
      input.toRevision > current.revision ||
      (await snapshot(historyPath)) !== "file"
    ) {
      return { outcome: "not-found", ...unchanged };
    }
    const target = await readBoundedSourceRecord(historyPath);
    if (
      target.sourceId !== current.sourceId ||
      !recordBelongsToStore(paths, target) ||
      target.revision !== input.toRevision
    ) {
      throw new Error("The saved source revision has inconsistent identity.");
    }
    const attachments: ScientSourceAttachment[] = [];
    let missingAttachmentCount = 0;
    for (const attachment of target.attachments) {
      if ((await snapshot(sourceAttachmentAbsolutePath(paths.location, attachment))) === "file") {
        attachments.push(attachment);
      } else {
        missingAttachmentCount += 1;
      }
    }
    const {
      revision: _revision,
      updatedAt: _updatedAt,
      updatedBy: _updatedBy,
      origin: _origin,
      citationKey: _citationKey,
      ...content
    } = target;
    const next: ScientSourceRecord = {
      ...content,
      ...revertPreservedFields(current),
      attachments,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    if (changedRevisionFields(current, next).length === 0) {
      return { outcome: "unchanged", ...unchanged, missingAttachmentCount };
    }
    const duplicate = assessSourceMetadataDuplicate({
      source: editableMetadataFromRecord(next),
      existing: (await listScientSourceRecordsFromPaths(paths)).filter(
        (record) => record.sourceId !== current.sourceId,
      ),
    });
    if (duplicate.kind === "same-identifier") {
      return {
        outcome: "duplicate",
        ...unchanged,
        matchingSourceIds: duplicate.matchingSourceIds,
      };
    }
    await persistSourceRevision(paths, current, next);
    return { outcome: "reverted", record: next, missingAttachmentCount, matchingSourceIds: [] };
  });
}

interface RecordScan {
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly issues: ReadonlyArray<ScientSourceStoreIssue>;
}

type RecordFileResult =
  | { readonly record: ScientSourceRecord }
  | { readonly issue: ScientSourceStoreIssue };

async function readRecordFile(
  paths: SourceStorePaths,
  fileName: string,
): Promise<RecordFileResult> {
  const filePath = NodePath.join(paths.records, fileName);
  try {
    const record = await readBoundedSourceRecord(filePath);
    if (!recordBelongsToStore(paths, record)) {
      throw new Error(storeOwnerMessage(paths, "The source record"));
    }
    if (`${record.sourceId}.json` !== fileName) {
      throw new Error("The source record identity does not match its file name.");
    }
    return { record };
  } catch (error) {
    return { issue: { path: projectRelativePath(paths, filePath), message: issueMessage(error) } };
  }
}

function settleScan(results: ReadonlyArray<RecordFileResult>): RecordScan {
  const records: ScientSourceRecord[] = [];
  const issues: ScientSourceStoreIssue[] = [];
  for (const result of results) {
    if ("record" in result) records.push(result.record);
    else issues.push(result.issue);
  }
  return {
    records: records.toSorted((left, right) => right.importedAt.localeCompare(left.importedAt)),
    issues,
  };
}

/** Lists every readable record and reports the others by path instead of failing the whole list. */
async function scanScientSourceRecords(paths: SourceStorePaths): Promise<RecordScan> {
  if (paths.owner.kind === "library") return scanLibraryRecords(paths);
  const recordsState = await snapshot(paths.records);
  if (recordsState === "missing") return { records: [], issues: [] };
  if (recordsState !== "directory") throw new Error("The Scient source record store is unsafe.");
  const entries = await NodeFSP.readdir(paths.records, { withFileTypes: true });
  const results: RecordFileResult[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) {
      const filePath = NodePath.join(paths.records, entry.name);
      results.push({
        issue: { path: projectRelativePath(paths, filePath), message: UNSAFE_ENTRY_MESSAGE },
      });
      continue;
    }
    results.push(await readRecordFile(paths, entry.name));
  }
  return settleScan(results);
}

/**
 * Timestamps this close to a scan may still change without changing again (coarse clocks on some
 * volumes), so such files and folders are checked again on the next scan instead of trusted.
 */
const RACY_TIMESTAMP_NS = 2_000_000_000n;

const RECORD_SCAN_CONCURRENCY = 32;

/** Editing a file in place leaves its folder's timestamps alone, so the folder alone is trusted briefly. */
const FOLDER_TRUST_MS = 30_000;

interface IndexedRecordFile {
  readonly stamp: string;
  readonly settled: boolean;
  readonly result: RecordFileResult;
}

interface LibraryRecordIndex extends RecordScan {
  readonly fingerprint: string;
  readonly settled: boolean;
  readonly validatedAtMs: number;
  readonly files: ReadonlyMap<string, IndexedRecordFile>;
}

/** Derived from the record files and rebuilt from them; the files stay the truth. */
const libraryRecordIndexes = new Map<string, LibraryRecordIndex>();

const isSettled = (stats: NodeFS.BigIntStats, scanStartedNs: bigint) =>
  scanStartedNs - stats.mtimeNs > RACY_TIMESTAMP_NS &&
  scanStartedNs - stats.ctimeNs > RACY_TIMESTAMP_NS;

/**
 * The library's record list from its in-memory index. Every library write replaces, links or
 * unlinks a file in `records/`, which changes the folder's timestamps; while those are unchanged
 * and recently checked, the index answers without touching any record. Otherwise each file is
 * checked by its own timestamps and only new or changed files are read again.
 */
async function scanLibraryRecords(paths: SourceStorePaths): Promise<RecordScan> {
  const scanStartedMs = Date.now();
  const scanStartedNs = BigInt(scanStartedMs) * 1_000_000n;
  const folder = await NodeFSP.lstat(paths.records, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  if (!folder) {
    libraryRecordIndexes.delete(paths.root);
    return { records: [], issues: [] };
  }
  if (!folder.isDirectory() || folder.isSymbolicLink()) {
    throw new Error("The Scient source record store is unsafe.");
  }
  const fingerprint = [folder.dev, folder.ino, folder.mtimeNs, folder.ctimeNs].join(":");
  const cached = libraryRecordIndexes.get(paths.root);
  if (
    cached?.settled &&
    cached.fingerprint === fingerprint &&
    scanStartedMs - cached.validatedAtMs < FOLDER_TRUST_MS
  ) {
    return cached;
  }

  const entries = await NodeFSP.readdir(paths.records, { withFileTypes: true });
  const names = entries
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json"))
    .toSorted((left, right) => left.localeCompare(right));
  const indexFile = async (name: string): Promise<IndexedRecordFile | null> => {
    const filePath = NodePath.join(paths.records, name);
    const stats = await NodeFSP.lstat(filePath, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!stats) return null;
    if (!stats.isFile()) {
      return {
        stamp: "unsafe",
        settled: false,
        result: {
          issue: { path: projectRelativePath(paths, filePath), message: UNSAFE_ENTRY_MESSAGE },
        },
      };
    }
    const stamp = [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
    const previous = cached?.files.get(name);
    return previous?.settled && previous.stamp === stamp
      ? previous
      : {
          stamp,
          settled: isSettled(stats, scanStartedNs),
          result: await readRecordFile(paths, name),
        };
  };
  const files = new Map<string, IndexedRecordFile>();
  // One file at a time waits on each stat and read in turn: 20,000 serial stats take 0.6 s.
  for (let start = 0; start < names.length; start += RECORD_SCAN_CONCURRENCY) {
    const part = names.slice(start, start + RECORD_SCAN_CONCURRENCY);
    const indexed = await Promise.all(part.map(indexFile));
    for (const [offset, file] of indexed.entries()) if (file) files.set(part[offset]!, file);
  }
  const index: LibraryRecordIndex = {
    ...settleScan([...files.values()].map((file) => file.result)),
    fingerprint,
    settled: isSettled(folder, scanStartedNs),
    validatedAtMs: scanStartedMs,
    files,
  };
  libraryRecordIndexes.set(paths.root, index);
  return index;
}

async function listScientSourceRecordsFromPaths(
  paths: SourceStorePaths,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  return (await scanScientSourceRecords(paths)).records;
}

export async function listScientSourceRecords(
  root: ScientSourceStoreLocation,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  return listScientSourceRecordsFromPaths(await sourceStorePaths(root));
}

async function operationRecordSnapshot(
  paths: SourceStorePaths,
  operationId: string,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  const key = operationCacheKey(paths, operationId);
  const fingerprint = await recordsDirectoryFingerprint(paths);
  const cached = operationRecordSnapshots.get(key);
  if (cached?.fingerprint === fingerprint) return cached.records;
  const records = await listScientSourceRecordsFromPaths(paths);
  const refreshedFingerprint = await recordsDirectoryFingerprint(paths);
  if (refreshedFingerprint === fingerprint) {
    operationRecordSnapshots.set(key, { fingerprint: refreshedFingerprint, records });
  } else {
    operationRecordSnapshots.delete(key);
  }
  return records;
}

async function replaceOperationRecordSnapshot(
  paths: SourceStorePaths,
  operationId: string,
  records: ReadonlyArray<ScientSourceRecord>,
): Promise<void> {
  operationRecordSnapshots.set(operationCacheKey(paths, operationId), {
    fingerprint: await recordsDirectoryFingerprint(paths),
    records,
  });
}

function operationPath(directory: string, operationId: string): string {
  assertSafeIdentifier(operationId, "Operation ID");
  return NodePath.join(directory, `${operationId}.json`);
}

export async function readSourceImportOperation(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<ScientSourceImportOperation | null> {
  const paths = await sourceStorePaths(root);
  return readSourceImportOperationFromPaths(paths, operationId);
}

async function readSourceImportOperationFromPaths(
  paths: SourceStorePaths,
  operationId: string,
): Promise<ScientSourceImportOperation | null> {
  const filePath = operationPath(paths.operations, operationId);
  if ((await snapshot(filePath)) === "missing") return null;
  const persisted = await readBoundedJson(
    filePath,
    MAX_OPERATION_BYTES,
    PersistedScientSourceImportOperation,
  );
  // A missing adapter is unambiguously Zotero: it is the only importer that
  // existed when the legacy operation shape was written. Normalize in memory;
  // read-only inspection must not rewrite project evidence unexpectedly.
  const operation: ScientSourceImportOperation = {
    ...persisted,
    adapter: persisted.adapter ?? "zotero",
    actor: persisted.actor ?? "user",
    intake: persisted.intake ?? (persisted.adapter === "local-files" ? "local-pdf" : "zotero"),
  };
  if (!operationBelongsToStore(paths, operation)) {
    throw new Error(storeOwnerMessage(paths, "The source import operation"));
  }
  return operation;
}

async function findActiveOperation(
  paths: SourceStorePaths,
): Promise<ScientSourceImportOperation | null> {
  const cachedOperationId = activeOperationIds.get(paths.root);
  if (cachedOperationId) {
    let cached = await readSourceImportOperationFromPaths(paths, cachedOperationId);
    if (cached?.state === "running" && cached.items.every((item) => item.state !== "pending")) {
      cached = await withStoreLock(paths, cachedOperationId, async () => {
        const current = await readSourceImportOperationFromPaths(paths, cachedOperationId);
        if (!current) return null;
        return finishOperationIfSettled(paths, current);
      });
    }
    if (cached?.state === "running") return cached;
    clearOperationCaches(paths, cachedOperationId);
  }
  if ((await snapshot(paths.operations)) === "missing") return null;
  const entries = await NodeFSP.readdir(paths.operations, { withFileTypes: true });
  const operations: ScientSourceImportOperation[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const operationId = entry.name.slice(0, -".json".length);
    let operation = await readSourceImportOperationFromPaths(paths, operationId);
    if (!operation) continue;
    if (!operationBelongsToStore(paths, operation)) {
      throw new Error(storeOwnerMessage(paths, `Source operation ${entry.name}`));
    }
    if (
      operation.state === "running" &&
      operation.items.every((item) => item.state !== "pending")
    ) {
      const operationId = operation.operationId;
      operation = await withStoreLock(paths, operationId, async () => {
        const current = await readSourceImportOperationFromPaths(paths, operationId);
        if (!current) throw new Error("The source import operation was not found.");
        return finishOperationIfSettled(paths, current);
      });
    }
    if (operation.state === "running") operations.push(operation);
  }
  const active =
    operations.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  if (active) activeOperationIds.set(paths.root, active.operationId);
  else activeOperationIds.delete(paths.root);
  return active;
}

export async function inspectScientSources(root: string): Promise<ScientSourcesOverview> {
  const project = await inspectScientProject(root);
  if (project.state !== "initialized") {
    return {
      projectState: project.state,
      issues: project.issues,
      records: [],
      activeOperation: null,
    };
  }
  const paths = await sourceStorePaths(project.root);
  const [scan, activeOperation, trash] = await Promise.all([
    scanScientSourceRecords(paths),
    findActiveOperation(paths),
    scanTrash(paths),
  ]);
  return {
    projectState: "initialized",
    issues: [],
    records: scan.records,
    activeOperation,
    ...(scan.issues.length > 0 ? { unreadableRecords: scan.issues } : {}),
    ...(trash.entries.length > 0 ? { trashedCount: trash.entries.length } : {}),
  };
}

/** The library's records, its running import and its trash count; reading writes nothing. */
export async function inspectScientLibrarySources(library: ScientLibraryLocation): Promise<{
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly activeOperation: ScientSourceImportOperation | null;
  readonly unreadableRecords?: ReadonlyArray<ScientSourceStoreIssue>;
  readonly trashedCount?: number;
}> {
  const paths = await sourceStorePaths(library);
  const [scan, activeOperation, trash] = await Promise.all([
    scanScientSourceRecords(paths),
    findActiveOperation(paths),
    scanTrash(paths),
  ]);
  return {
    records: scan.records,
    activeOperation,
    ...(scan.issues.length > 0 ? { unreadableRecords: scan.issues } : {}),
    ...(trash.entries.length > 0 ? { trashedCount: trash.entries.length } : {}),
  };
}

export async function createSourceImportOperation(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly adapter: "zotero" | "zotero-web" | "local-files" | "file";
  readonly actor?: "user" | "agent";
  readonly intake?: "zotero" | "local-pdf" | "identifier" | "file";
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides?: ReadonlyArray<string>;
  /** The Zotero group library the item keys belong to; omitted for My Library. */
  readonly zoteroGroupId?: string;
  /** Library stores only: the checkout instance the imported sources are pinned in. */
  readonly pinInstanceId?: string;
}): Promise<ScientSourceImportOperation> {
  assertSafeIdentifier(input.operationId, "Operation ID");
  if (input.pinInstanceId !== undefined) assertSafeIdentifier(input.pinInstanceId, "Instance ID");
  if (input.zoteroGroupId !== undefined && !/^[1-9][0-9]{0,11}$/u.test(input.zoteroGroupId)) {
    throw new Error("The Zotero group ID is invalid.");
  }
  const uniqueItemKeys = [...new Set(input.itemKeys)];
  if (uniqueItemKeys.length === 0) throw new Error("Choose at least one source to import.");
  if (uniqueItemKeys.length > SCIENT_SOURCE_IMPORT_ITEM_LIMIT) {
    throw new Error(
      `Choose no more than ${SCIENT_SOURCE_IMPORT_ITEM_LIMIT} sources in one import.`,
    );
  }
  for (const itemKey of uniqueItemKeys) assertSafeIdentifier(itemKey, "Source item key");
  const overrides = new Set(input.possibleMetadataMatchOverrides ?? []);
  for (const itemKey of overrides) {
    assertSafeIdentifier(itemKey, "Source item key");
    if (!uniqueItemKeys.includes(itemKey)) {
      throw new Error("A possible-match override must belong to the import selection.");
    }
  }
  const normalizedOverrides = uniqueItemKeys.filter((itemKey) => overrides.has(itemKey));
  const paths = await sourceStorePaths(input.root);
  if (input.pinInstanceId !== undefined && paths.owner.kind !== "library") {
    throw new Error("Only a library import pins its sources into a project.");
  }
  return withStoreLock(paths, "active-operation", async () => {
    const existing = await readSourceImportOperationFromPaths(paths, input.operationId);
    if (existing) {
      const existingKeys = existing.items.map((item) => item.itemKey);
      const existingOverrides = existing.items.flatMap((item) =>
        item.allowPossibleMetadataMatch ? [item.itemKey] : [],
      );
      if (
        existingKeys.join("\0") !== uniqueItemKeys.join("\0") ||
        existingOverrides.join("\0") !== normalizedOverrides.join("\0") ||
        existing.adapter !== input.adapter ||
        existing.zoteroGroupId !== input.zoteroGroupId ||
        existing.pinInstanceId !== input.pinInstanceId ||
        existing.actor !== (input.actor ?? "user") ||
        existing.intake !==
          (input.intake ?? (input.adapter === "local-files" ? "local-pdf" : "zotero"))
      ) {
        throw new Error("This operation ID was already used for another import selection.");
      }
      if (existing.state === "running") {
        activeOperationIds.set(paths.root, existing.operationId);
      }
      return existing;
    }
    const active = await findActiveOperation(paths);
    if (active) {
      throw new Error(
        paths.owner.kind === "library"
          ? "Another source import is already running in the Library."
          : "Another source import is already running for this project.",
      );
    }
    const now = new Date().toISOString();
    const operation: ScientSourceImportOperation = {
      formatVersion: storeFormatVersion(paths),
      operationId: input.operationId,
      ...storeOwnerField(paths),
      adapter: input.adapter,
      actor: input.actor ?? "user",
      intake: input.intake ?? (input.adapter === "local-files" ? "local-pdf" : "zotero"),
      state: "running",
      createdAt: now,
      updatedAt: now,
      items: uniqueItemKeys.map((itemKey) => ({
        itemKey,
        allowPossibleMetadataMatch: overrides.has(itemKey),
        state: "pending",
        sourceId: null,
        message: null,
      })),
      ...(input.zoteroGroupId ? { zoteroGroupId: input.zoteroGroupId } : {}),
      ...(input.pinInstanceId ? { pinInstanceId: input.pinInstanceId } : {}),
    };
    await atomicWriteJson(
      operationPath(paths.operations, input.operationId),
      operation,
      MAX_OPERATION_BYTES,
    );
    activeOperationIds.set(paths.root, operation.operationId);
    return operation;
  });
}

async function finishOperationIfSettled(
  paths: SourceStorePaths,
  operation: ScientSourceImportOperation,
): Promise<ScientSourceImportOperation> {
  if (operation.state !== "running" || operation.items.some((item) => item.state === "pending")) {
    return operation;
  }
  const completed: ScientSourceImportOperation = {
    ...operation,
    state: "completed",
    updatedAt: new Date().toISOString(),
  };
  const receipt: ScientSourceImportReceipt = {
    formatVersion: completed.formatVersion,
    operationId: completed.operationId,
    ...storeOwnerField(paths),
    outcome: "completed",
    finishedAt: completed.updatedAt,
    importedSourceIds: completed.items.flatMap((item) =>
      item.state === "imported" && item.sourceId ? [item.sourceId] : [],
    ),
    skippedItemKeys: completed.items.flatMap((item) =>
      item.state === "skipped" ? [item.itemKey] : [],
    ),
    failedItemKeys: completed.items.flatMap((item) =>
      item.state === "failed" ? [item.itemKey] : [],
    ),
    unprocessedItemKeys: [],
  };
  await atomicWriteJson(
    operationPath(paths.operations, completed.operationId),
    completed,
    MAX_OPERATION_BYTES,
  );
  await atomicWriteJson(
    operationPath(paths.receipts, completed.operationId),
    receipt,
    MAX_OPERATION_BYTES,
  );
  clearOperationCaches(paths, completed.operationId);
  return completed;
}

export async function updateSourceImportOperationItem(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly itemKey: string;
  readonly state: "imported" | "skipped" | "failed";
  readonly duplicateKind?: ScientSourceDuplicateKind;
  readonly sourceId?: string;
  readonly message?: string;
  readonly note?: string;
}): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, input.operationId, async () => {
    const operation = await readSourceImportOperationFromPaths(paths, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    if (!operation.items.some((item) => item.itemKey === input.itemKey)) {
      throw new Error("The source item is not part of this import operation.");
    }
    const updated: ScientSourceImportOperation = {
      ...operation,
      updatedAt: new Date().toISOString(),
      items: operation.items.map((item) =>
        item.itemKey === input.itemKey
          ? {
              ...item,
              state: input.state,
              ...(input.duplicateKind ? { duplicateKind: input.duplicateKind } : {}),
              sourceId: input.sourceId ?? null,
              message: input.message ?? null,
              ...(input.note ? { note: input.note } : {}),
            }
          : item,
      ),
    };
    await atomicWriteJson(
      operationPath(paths.operations, input.operationId),
      updated,
      MAX_OPERATION_BYTES,
    );
    return finishOperationIfSettled(paths, updated);
  });
}

export async function retryFailedSourceImportOperationItems(
  root: ScientSourceStoreLocation,
  operationId: string,
  itemKeys: ReadonlyArray<string>,
): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(root);
  const keys = [...new Set(itemKeys)];
  if (keys.length === 0) throw new Error("Choose at least one failed source item to retry.");
  for (const key of keys) assertSafeIdentifier(key, "Source item key");
  return withStoreLock(paths, operationId, async () => {
    const operation = await readSourceImportOperationFromPaths(paths, operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state === "cancelled") {
      throw new Error("A cancelled source import cannot retry failed items.");
    }
    const selected = new Set(keys);
    const operationKeys = new Set(operation.items.map((item) => item.itemKey));
    for (const key of keys) {
      if (!operationKeys.has(key))
        throw new Error("The source item was not found in this operation.");
    }
    for (const item of operation.items) {
      if (selected.has(item.itemKey) && item.state !== "failed") {
        throw new Error("Only failed source items can be retried.");
      }
    }
    const updated: ScientSourceImportOperation = {
      ...operation,
      state: "running",
      updatedAt: new Date().toISOString(),
      items: operation.items.map((item) =>
        selected.has(item.itemKey) ? { ...item, state: "pending", message: null } : item,
      ),
    };
    await atomicWriteJson(
      operationPath(paths.operations, operationId),
      updated,
      MAX_OPERATION_BYTES,
    );
    activeOperationIds.set(paths.root, operationId);
    return updated;
  });
}

export async function cancelSourceImportOperation(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(root);
  return withStoreLock(paths, operationId, async () => {
    const operation = await readSourceImportOperationFromPaths(paths, operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    const now = new Date().toISOString();
    const cancelled: ScientSourceImportOperation = {
      ...operation,
      state: "cancelled",
      updatedAt: now,
    };
    const receipt: ScientSourceImportReceipt = {
      formatVersion: operation.formatVersion,
      operationId,
      ...storeOwnerField(paths),
      outcome: "cancelled",
      finishedAt: now,
      importedSourceIds: operation.items.flatMap((item) =>
        item.state === "imported" && item.sourceId ? [item.sourceId] : [],
      ),
      skippedItemKeys: operation.items.flatMap((item) =>
        item.state === "skipped" ? [item.itemKey] : [],
      ),
      failedItemKeys: operation.items.flatMap((item) =>
        item.state === "failed" ? [item.itemKey] : [],
      ),
      unprocessedItemKeys: operation.items.flatMap((item) =>
        item.state === "pending" ? [item.itemKey] : [],
      ),
    };
    await atomicWriteJson(
      operationPath(paths.operations, operationId),
      cancelled,
      MAX_OPERATION_BYTES,
    );
    await atomicWriteJson(operationPath(paths.receipts, operationId), receipt, MAX_OPERATION_BYTES);
    clearOperationCaches(paths, operationId);
    return cancelled;
  });
}

/** Importing the same source key into the same project always yields the same source ID. */
export function scientSourceIdFor(projectId: string, sourceKey: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update([projectId, sourceKey].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `source_${digest}`;
}

export interface ScientSourcePdfInspection {
  readonly sha256: string;
  readonly byteLength: number;
}

export async function resolveScientSourceInputPdf(
  root: string,
  relativePath: string,
): Promise<{ readonly absolutePath: string; readonly fileName: string }> {
  const resolved = await resolveScientProjectFile(root, relativePath, {
    extensions: [".pdf"],
    description: "PDF",
    // Library PDFs are opened and annotated from Library storage.
    allowScientStorage: true,
  });
  return {
    absolutePath: resolved.absolutePath,
    fileName: safeUploadedFileName(NodePath.basename(relativePath.trim())),
  };
}

async function readValidatedPdf(
  sourcePath: string,
  writeChunk?: (chunk: Buffer) => Promise<void>,
): Promise<ScientSourcePdfInspection> {
  const sourceStats = await NodeFSP.lstat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error("The source PDF is not a safe regular file.");
  }
  if (sourceStats.size > MAX_PDF_BYTES) {
    throw new Error("The source PDF exceeds the 512 MiB import limit.");
  }
  // O_NOFOLLOW is undefined on Windows; there the lstat check above and the identity check below stand.
  const sourceHandle = await NodeFSP.open(
    sourcePath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStats = await sourceHandle.stat();
    if (openedStats.ino !== sourceStats.ino || openedStats.dev !== sourceStats.dev) {
      throw new Error("The source PDF changed while Scient was reading it. Try again.");
    }
    const digest = NodeCrypto.createHash("sha256");
    let byteLength = 0;
    let header = Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (header.byteLength < 5)
        header = Buffer.concat([header, chunk.subarray(0, 5)]).subarray(0, 5);
      byteLength += bytesRead;
      if (byteLength > MAX_PDF_BYTES) throw new Error("The PDF grew beyond the safe import limit.");
      digest.update(chunk);
      await writeChunk?.(chunk);
    }
    const finalSourceStats = await sourceHandle.stat();
    if (
      finalSourceStats.size !== sourceStats.size ||
      finalSourceStats.mtimeMs !== sourceStats.mtimeMs
    ) {
      throw new Error("The source PDF changed while Scient was reading it. Try again.");
    }
    if (header.toString("ascii") !== "%PDF-") {
      throw new Error("The selected file is not a valid PDF.");
    }
    return { sha256: digest.digest("hex"), byteLength };
  } finally {
    await sourceHandle.close();
  }
}

export async function inspectScientSourcePdf(
  sourcePath: string,
): Promise<ScientSourcePdfInspection> {
  return readValidatedPdf(sourcePath);
}

/** A PDF's bytes, read once without following a final symlink; refused unless they have the expected size and hash. */
export async function readScientSourcePdfBytes(
  sourcePath: string,
  expected: ScientSourcePdfInspection,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(expected.byteLength);
  let offset = 0;
  const read = await readValidatedPdf(sourcePath, async (chunk) => {
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new Error("The PDF does not match its recorded size.");
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  if (read.byteLength !== expected.byteLength || read.sha256 !== expected.sha256) {
    throw new Error("The PDF does not match its recorded size and hash.");
  }
  return bytes;
}

/**
 * A stored attachment's PDF bytes: canonically inside the source store, reached
 * through no symlink, with the attachment's recorded size and hash.
 */
export async function readScientSourceAttachmentPdf(
  root: ScientSourceStoreLocation,
  attachment: ScientSourceAttachment,
): Promise<Uint8Array<ArrayBuffer>> {
  if (isScientLibraryLocation(root)) {
    const library = scientLibraryLocation(await NodeFSP.realpath(root.root));
    const lexicalPath = sourceAttachmentAbsolutePath(library, attachment);
    // The library holds no links: any symlink on the way changes the real path.
    if ((await NodeFSP.realpath(lexicalPath)) !== lexicalPath) {
      throw new Error("The source PDF is reached through a symlink.");
    }
    return readScientSourcePdfBytes(lexicalPath, {
      sha256: attachment.sha256,
      byteLength: attachment.byteLength,
    });
  }
  const canonicalRoot = await NodeFSP.realpath(root);
  const lexicalPath = sourceAttachmentAbsolutePath(canonicalRoot, attachment);
  const requested = NodePath.relative(canonicalRoot, lexicalPath).split(NodePath.sep).join("/");
  const resolved = await resolveScientProjectFile(canonicalRoot, requested, {
    extensions: [".pdf"],
    description: "source PDF",
    allowScientStorage: true,
  });
  if (resolved.relativePath !== requested) {
    throw new Error("The source PDF is reached through a symlink.");
  }
  return readScientSourcePdfBytes(resolved.absolutePath, {
    sha256: attachment.sha256,
    byteLength: attachment.byteLength,
  });
}

function stagedLocalMaterialPaths(paths: SourceStorePaths, sourceKey: string) {
  assertSafeIdentifier(sourceKey, "Source key");
  const directory = NodePath.join(paths.staging, "local-files");
  return {
    directory,
    pdf: NodePath.join(directory, `${sourceKey}.pdf`),
    metadata: NodePath.join(directory, `${sourceKey}.json`),
  };
}

function safeUploadedFileName(fileName: string): string {
  const base = [...NodePath.basename(fileName.trim())]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("");
  return base.slice(0, 255) || "source.pdf";
}

export async function stageScientSourcePdfUpload(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourcePath: string;
  readonly fileName: string;
}): Promise<{
  readonly sourceKey: string;
  readonly pdfFileName: string;
  readonly pdfRelativePath: string;
  readonly pdfSha256: string;
  readonly byteLength: number;
  readonly absolutePath: string;
}> {
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, "source-upload", async () => {
    if (!input.fileName.toLowerCase().endsWith(".pdf")) {
      throw new Error("The selected file is not a PDF.");
    }
    const localDirectory = NodePath.join(paths.staging, "local-files");
    await ensureDirectory(localDirectory);
    const temporaryPath = NodePath.join(localDirectory, `upload-${NodeCrypto.randomUUID()}.tmp`);
    let targetHandle: NodeFSP.FileHandle | null = null;
    try {
      targetHandle = await NodeFSP.open(temporaryPath, "wx", 0o600);
      const openTarget = targetHandle;
      const inspected = await readValidatedPdf(input.sourcePath, async (chunk) => {
        await openTarget.writeFile(chunk);
      });
      await targetHandle.sync();
      await targetHandle.close();
      targetHandle = null;
      const sourceKey = `local_${inspected.sha256}_${NodeCrypto.randomUUID()}`;
      const materialPaths = stagedLocalMaterialPaths(paths, sourceKey);
      try {
        await NodeFSP.link(temporaryPath, materialPaths.pdf);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
          try {
            await NodeFSP.copyFile(
              temporaryPath,
              materialPaths.pdf,
              NodeFSP.constants.COPYFILE_EXCL,
            );
          } catch (copyError) {
            if (!isNodeError(copyError, "EEXIST")) throw copyError;
          }
        }
      }
      const existing = await readValidatedPdf(materialPaths.pdf);
      if (existing.sha256 !== inspected.sha256 || existing.byteLength !== inspected.byteLength) {
        throw new Error("The staged source PDF does not match the uploaded file.");
      }
      return {
        sourceKey,
        pdfFileName: safeUploadedFileName(input.fileName),
        pdfRelativePath: NodePath.posix.join("staging", "local-files", `${sourceKey}.pdf`),
        pdfSha256: inspected.sha256,
        byteLength: inspected.byteLength,
        absolutePath: materialPaths.pdf,
      };
    } finally {
      await targetHandle?.close();
      await NodeFSP.rm(temporaryPath, { force: true });
    }
  });
}

export async function writeScientSourceStagedMaterial(
  root: ScientSourceStoreLocation,
  material: ScientSourceStagedMaterialType,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  const decoded = decodeScientSourceStagedMaterial(material);
  if (decoded.candidate.sourceKey !== decoded.sourceKey) {
    throw new Error("The staged source identity is inconsistent.");
  }
  const materialPaths = stagedLocalMaterialPaths(paths, decoded.sourceKey);
  const expectedRelativePath = NodePath.posix.join(
    "staging",
    "local-files",
    `${decoded.sourceKey}.pdf`,
  );
  if (decoded.pdfRelativePath !== expectedRelativePath) {
    throw new Error("The staged source path is inconsistent.");
  }
  const inspected = await readValidatedPdf(materialPaths.pdf);
  if (inspected.sha256 !== decoded.pdfSha256 || inspected.byteLength !== decoded.byteLength) {
    throw new Error("The staged source PDF changed before metadata was saved.");
  }
  await asLibraryWriter(paths, () =>
    atomicWriteJson(materialPaths.metadata, decoded, MAX_STAGED_MATERIAL_BYTES),
  );
}

export async function readScientSourceStagedMaterial(
  root: ScientSourceStoreLocation,
  sourceKey: string,
): Promise<ScientSourceStagedMaterialType> {
  const paths = await sourceStorePaths(root);
  const materialPaths = stagedLocalMaterialPaths(paths, sourceKey);
  const material = await readBoundedJson(
    materialPaths.metadata,
    MAX_STAGED_MATERIAL_BYTES,
    ScientSourceStagedMaterial,
  );
  if (material.sourceKey !== sourceKey || material.candidate.sourceKey !== sourceKey) {
    throw new Error("The staged source identity is inconsistent.");
  }
  return material;
}

export async function stagedScientSourcePdfAbsolutePath(
  root: ScientSourceStoreLocation,
  material: ScientSourceStagedMaterialType,
): Promise<string> {
  const paths = await sourceStorePaths(root);
  const materialPaths = stagedLocalMaterialPaths(paths, material.sourceKey);
  const expectedRelativePath = NodePath.posix.join(
    "staging",
    "local-files",
    `${material.sourceKey}.pdf`,
  );
  if (material.pdfRelativePath !== expectedRelativePath) {
    throw new Error("The staged source path is inconsistent.");
  }
  return materialPaths.pdf;
}

export async function removeScientSourceStagedMaterial(
  root: ScientSourceStoreLocation,
  sourceKey: string,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  const materialPaths = stagedLocalMaterialPaths(paths, sourceKey);
  await asLibraryWriter(paths, () =>
    Promise.all([
      NodeFSP.rm(materialPaths.pdf, { force: true }),
      NodeFSP.rm(materialPaths.metadata, { force: true }),
    ]),
  );
}

const MAX_STAGED_FILE_IMPORT_BYTES = 64 * 1024 * 1024;
/** Linked PDFs attached to one entry of a reference file. */
export const SCIENT_SOURCE_LINKED_PDF_LIMIT = 20;

/** Candidates read from one reference file, held until their import operation settles. */
const ScientSourceStagedFileImport = Schema.Struct({
  formatVersion: Schema.Literal(1),
  operationId: Schema.String.check(Schema.isNonEmpty()),
  fileName: Schema.String,
  report: BibliographyImportReport,
  candidates: Schema.Array(ScientSourceCandidate).pipe(
    Schema.check(Schema.isMaxLength(SCIENT_SOURCE_IMPORT_ITEM_LIMIT)),
  ),
  /** PDFs the file names for a staged entry, by source key: real paths checked at staging. */
  pdfs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ path: Schema.String, fileName: Schema.String })).pipe(
        Schema.check(Schema.isMaxLength(SCIENT_SOURCE_LINKED_PDF_LIMIT)),
      ),
    ),
  ),
});
export type ScientSourceStagedFileImport = typeof ScientSourceStagedFileImport.Type;
const decodeStagedFileImport = Schema.decodeSync(ScientSourceStagedFileImport);

function stagedFileImportPath(paths: SourceStorePaths, operationId: string): string {
  assertSafeIdentifier(operationId, "Operation ID");
  return NodePath.join(paths.staging, "files", `${operationId}.json`);
}

export async function writeScientSourceStagedFileImport(
  root: ScientSourceStoreLocation,
  staged: ScientSourceStagedFileImport,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  const decoded = decodeStagedFileImport(staged);
  await asLibraryWriter(paths, () =>
    atomicWriteJson(
      stagedFileImportPath(paths, decoded.operationId),
      decoded,
      MAX_STAGED_FILE_IMPORT_BYTES,
    ),
  );
}

export async function readScientSourceStagedFileImport(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<ScientSourceStagedFileImport | null> {
  const paths = await sourceStorePaths(root);
  const filePath = stagedFileImportPath(paths, operationId);
  if ((await snapshot(filePath)) === "missing") return null;
  const staged = await readBoundedJson(
    filePath,
    MAX_STAGED_FILE_IMPORT_BYTES,
    ScientSourceStagedFileImport,
  );
  if (staged.operationId !== operationId) {
    throw new Error("The staged file import identity is inconsistent.");
  }
  return staged;
}

export async function removeScientSourceStagedFileImport(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  await asLibraryWriter(paths, () =>
    NodeFSP.rm(stagedFileImportPath(paths, operationId), { force: true }),
  );
}

async function stagePdf(input: {
  readonly paths: SourceStorePaths;
  readonly operationId: string;
  readonly sourcePath: string;
  readonly fileName?: string;
  readonly expectedPdf?: ScientSourcePdfInspection;
  readonly importedAt: string;
  readonly retrieval?: ScientSourceAttachmentRetrieval;
}): Promise<ScientSourceAttachment> {
  const stagingDirectory = NodePath.join(input.paths.staging, input.operationId);
  await ensureDirectory(stagingDirectory);
  const temporaryPath = NodePath.join(stagingDirectory, `pdf-${NodeCrypto.randomUUID()}.tmp`);
  let targetHandle: NodeFSP.FileHandle | null = null;
  try {
    targetHandle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    const openTarget = targetHandle;
    const { sha256, byteLength } = await readValidatedPdf(input.sourcePath, async (chunk) => {
      await openTarget.writeFile(chunk);
    });
    if (
      input.expectedPdf &&
      (sha256 !== input.expectedPdf.sha256 || byteLength !== input.expectedPdf.byteLength)
    ) {
      throw new Error("The source PDF changed after review. Select it again before importing.");
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    const relativePath = NodePath.posix.join(
      "files",
      "sha256",
      sha256.slice(0, 2),
      `${sha256}.pdf`,
    );
    const finalPath = NodePath.join(input.paths.base, ...relativePath.split("/"));
    await ensureDirectory(NodePath.dirname(finalPath));
    let created = false;
    try {
      await NodeFSP.link(temporaryPath, finalPath);
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
        try {
          await NodeFSP.copyFile(temporaryPath, finalPath, NodeFSP.constants.COPYFILE_EXCL);
          created = true;
        } catch (copyError) {
          if (!isNodeError(copyError, "EEXIST")) throw copyError;
        }
      }
    }
    const finalStats = await NodeFSP.lstat(finalPath);
    if (!finalStats.isFile() || finalStats.isSymbolicLink() || finalStats.size !== byteLength) {
      throw new Error("The project already contains an unsafe or damaged source PDF.");
    }
    if (!created) {
      const existingHandle = await NodeFSP.open(finalPath, "r");
      const existingDigest = NodeCrypto.createHash("sha256");
      try {
        const existingBuffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        while (true) {
          const { bytesRead } = await existingHandle.read(
            existingBuffer,
            0,
            existingBuffer.byteLength,
            null,
          );
          if (bytesRead === 0) break;
          existingDigest.update(existingBuffer.subarray(0, bytesRead));
        }
      } finally {
        await existingHandle.close();
      }
      if (existingDigest.digest("hex") !== sha256) {
        throw new Error("The project already contains a damaged source PDF.");
      }
    }
    return {
      // A hash identifies immutable PDF bytes. An attachment ID identifies a
      // source-scoped reference to those bytes, so shared blobs need distinct
      // attachment IDs.
      attachmentId: `pdf_${NodeCrypto.randomUUID()}`,
      kind: "pdf",
      fileName: safeUploadedFileName(input.fileName ?? NodePath.basename(input.sourcePath)),
      mediaType: "application/pdf",
      sha256,
      byteLength,
      relativePath,
      importedAt: input.importedAt,
      ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    };
  } finally {
    await targetHandle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
    await NodeFSP.rmdir(stagingDirectory).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
    });
  }
}

export interface ScientSourcePdfAttachmentResult {
  readonly outcome: "attached" | "unchanged" | "stale";
  readonly record: ScientSourceRecord;
  readonly duplicate: ScientSourceDuplicateAssessment;
}

export async function attachScientSourcePdf(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly pdfPath: string;
  readonly fileName?: string;
  readonly actor?: ScientSourceActor;
  readonly retrieval?: ScientSourceAttachmentRetrieval;
}): Promise<ScientSourcePdfAttachmentResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    const emptyDuplicate: ScientSourceDuplicateAssessment = {
      kind: "new",
      matchingSourceIds: [],
      reason: "No duplicate source was found.",
    };
    if (current.revision !== input.expectedRevision) {
      return { outcome: "stale", record: current, duplicate: emptyDuplicate };
    }
    const attachment = await stagePdf({
      paths,
      operationId: `attach_${NodeCrypto.randomUUID()}`,
      sourcePath: input.pdfPath,
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.retrieval ? { retrieval: input.retrieval } : {}),
      importedAt: new Date().toISOString(),
    });
    const currentAttachment = current.attachments.some(
      (existingAttachment) => existingAttachment.sha256 === attachment.sha256,
    );
    if (currentAttachment) {
      return { outcome: "unchanged", record: current, duplicate: emptyDuplicate };
    }
    const next: ScientSourceRecord = {
      ...current,
      revision: current.revision + 1,
      attachments: [...current.attachments, attachment],
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    await persistSourceRevision(paths, current, next);
    return { outcome: "attached", record: next, duplicate: emptyDuplicate };
  });
}

export interface ScientSourcePdfDetachmentResult {
  readonly outcome: "removed" | "unchanged" | "stale" | "not-found";
  readonly record: ScientSourceRecord | null;
  readonly attachmentId: string;
  readonly removedAttachmentCount: number;
  readonly retainedAttachmentCount: number;
}

export async function detachScientSourcePdf(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly expectedRevision: number;
  readonly actor?: ScientSourceActor;
}): Promise<ScientSourcePdfDetachmentResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  assertSafeIdentifier(input.attachmentId, "Attachment ID");
  return withStoreLock(paths, "source-write", async () => {
    const recordPath = sourceRecordPath(paths, input.sourceId);
    if ((await snapshot(recordPath)) === "missing") {
      return {
        outcome: "not-found",
        record: null,
        attachmentId: input.attachmentId,
        removedAttachmentCount: 0,
        retainedAttachmentCount: 0,
      };
    }
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    if (current.revision !== input.expectedRevision) {
      return {
        outcome: "stale",
        record: current,
        attachmentId: input.attachmentId,
        removedAttachmentCount: 0,
        retainedAttachmentCount: current.attachments.length,
      };
    }
    if (!current.attachments.some((attachment) => attachment.attachmentId === input.attachmentId)) {
      return {
        outcome: "unchanged",
        record: current,
        attachmentId: input.attachmentId,
        removedAttachmentCount: 0,
        retainedAttachmentCount: current.attachments.length,
      };
    }

    const next: ScientSourceRecord = {
      ...current,
      revision: current.revision + 1,
      attachments: current.attachments.filter(
        (attachment) => attachment.attachmentId !== input.attachmentId,
      ),
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    await persistSourceRevision(paths, current, next);

    // The PDF file stays until the trash is emptied, so reverting this revision brings it back.
    return {
      outcome: "removed",
      record: next,
      attachmentId: input.attachmentId,
      removedAttachmentCount: 0,
      retainedAttachmentCount: 1,
    };
  });
}

interface ImportScientSourceInput {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly candidate: ScientSourceCandidate;
  readonly pdfPath?: string;
  readonly expectedPdf?: ScientSourcePdfInspection;
  readonly allowPossibleMetadataMatch?: boolean;
  readonly actor?: ScientSourceActor;
  readonly intake?: ScientSourceOrigin["intake"];
  readonly verification?: ScientSourceVerification;
  readonly editorialStatus?: ScientSourceEditorialStatus;
  readonly pdfRetrieval?: ScientSourceAttachmentRetrieval;
}

async function importScientSourceWithRecordLookup(
  input: ImportScientSourceInput,
  lookup: "complete" | "operation-snapshot",
): Promise<ImportedSourceResult> {
  assertSafeIdentifier(input.operationId, "Operation ID");
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, "source-write", async () => {
    const existing =
      lookup === "operation-snapshot"
        ? await operationRecordSnapshot(paths, input.operationId)
        : await listScientSourceRecordsFromPaths(paths);
    const importedAt = new Date().toISOString();
    const preliminaryDuplicate = assessSourceDuplicate({ candidate: input.candidate, existing });
    if (duplicateBlocksImport(preliminaryDuplicate, input.allowPossibleMetadataMatch ?? false)) {
      return { outcome: "duplicate", record: null, duplicate: preliminaryDuplicate };
    }
    const attachment = input.pdfPath
      ? await stagePdf({
          paths,
          operationId: input.operationId,
          sourcePath: input.pdfPath,
          ...(input.candidate.pdfFileName ? { fileName: input.candidate.pdfFileName } : {}),
          ...(input.expectedPdf ? { expectedPdf: input.expectedPdf } : {}),
          ...(input.pdfRetrieval ? { retrieval: input.pdfRetrieval } : {}),
          importedAt,
        })
      : null;
    const sourceId = scientSourceIdFor(storeOwnerId(paths), input.candidate.sourceKey);
    const duplicate = assessSourceDuplicate({
      candidate: input.candidate,
      existing,
      sourceId,
      ...(attachment ? { pdfSha256: attachment.sha256 } : {}),
    });
    if (duplicateBlocksImport(duplicate, input.allowPossibleMetadataMatch ?? false)) {
      return { outcome: "duplicate", record: null, duplicate };
    }
    const citationKey = assignCitationKey({
      preferred: input.candidate.citationKey,
      creators: input.candidate.creators,
      issuedYear: input.candidate.issuedYear,
      title: input.candidate.title,
      taken: takenCitationKeys(existing),
    });
    // Removing a source removes its current record but deliberately keeps prior
    // immutable revisions. Re-importing that same external source must continue
    // after those revisions rather than collide on the next metadata edit.
    const revision = (await latestSourceHistoryRevision(paths, sourceId)) + 1;
    const abstract =
      abstractDocumentFromSections(input.candidate.abstractSections) ??
      normalizeScientSourceAbstractDocument(input.candidate.abstract);
    const record: ScientSourceRecord = {
      formatVersion: storeFormatVersion(paths),
      sourceId,
      ...projectField(paths),
      revision,
      citationKey,
      type: input.candidate.type,
      customType: input.candidate.customType ?? null,
      title: input.candidate.title,
      creators: input.candidate.creators,
      issuedRaw: input.candidate.issuedRaw,
      issuedYear: input.candidate.issuedYear,
      identifiers: input.candidate.identifiers,
      // The store is the final adapter-independent guard for canonical source
      // metadata. Future importers cannot persist provider markup accidentally.
      abstract: abstract?.text ?? null,
      ...(abstract ? { abstractSections: [...abstract.sections] } : {}),
      containerTitle: input.candidate.containerTitle,
      publisher: input.candidate.publisher,
      volume: input.candidate.volume,
      issue: input.candidate.issue,
      pages: input.candidate.pages,
      language: input.candidate.language,
      url: input.candidate.url,
      tags: input.candidate.tags,
      ...(input.candidate.note ? { note: normalizeScientSourceNote(input.candidate.note) } : {}),
      externalReferences: input.candidate.externalReferences,
      attachments: attachment ? [attachment] : [],
      fieldProvenance: input.candidate.fieldProvenance,
      ...(input.actor
        ? {
            origin: {
              actor: input.actor,
              intake: input.intake ?? "local-pdf",
              operationId: input.operationId,
              review: "none",
            },
          }
        : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      ...(input.editorialStatus ? { editorialStatus: input.editorialStatus } : {}),
      importedAt,
      ...readingStateField(paths),
    };
    const recordPath = sourceRecordPath(paths, sourceId);
    if (!(await atomicCreateJson(recordPath, record, MAX_RECORD_BYTES))) {
      const concurrentRecords = await listScientSourceRecordsFromPaths(paths);
      if (lookup === "operation-snapshot") {
        await replaceOperationRecordSnapshot(paths, input.operationId, concurrentRecords);
      }
      const concurrentDuplicate = assessSourceDuplicate({
        candidate: input.candidate,
        existing: concurrentRecords,
        sourceId,
        ...(attachment ? { pdfSha256: attachment.sha256 } : {}),
      });
      if (concurrentDuplicate.kind === "new") {
        throw new Error("A conflicting source record was created concurrently.");
      }
      return { outcome: "duplicate", record: null, duplicate: concurrentDuplicate };
    }
    // Importing a trashed source again supersedes its trash entry.
    await NodeFSP.rm(trashEntryPath(paths, sourceId), { force: true });
    if (lookup === "operation-snapshot") {
      await replaceOperationRecordSnapshot(
        paths,
        input.operationId,
        [record, ...existing].toSorted((left, right) =>
          right.importedAt.localeCompare(left.importedAt),
        ),
      );
    }
    return { outcome: "imported", record, duplicate };
  });
}

/** Imports one standalone source after reading the current project ledger in full. */
export async function importScientSource(
  input: ImportScientSourceInput,
): Promise<ImportedSourceResult> {
  return importScientSourceWithRecordLookup(input, "complete");
}

/**
 * Imports one item from a durable operation while reusing a validated ledger
 * snapshot. Any source record mutation changes the records-directory identity
 * and forces a complete refresh before the next operation item.
 */
export async function importScientSourceOperationItem(
  input: ImportScientSourceInput,
): Promise<ImportedSourceResult> {
  return importScientSourceWithRecordLookup(input, "operation-snapshot");
}

export function sourceAttachmentAbsolutePath(
  root: ScientSourceStoreLocation,
  attachment: ScientSourceAttachment,
): string {
  if (attachment.relativePath.includes("\\")) {
    throw new Error("The source attachment path is not portable.");
  }
  const normalized = NodePath.posix.normalize(attachment.relativePath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    NodePath.posix.isAbsolute(normalized)
  ) {
    throw new Error("The source attachment path is not portable.");
  }
  const base = isScientLibraryLocation(root)
    ? NodePath.resolve(root.root)
    : NodePath.resolve(root, SCIENT_SOURCES_DIRECTORY);
  const resolved = NodePath.resolve(base, ...normalized.split("/"));
  const relative = NodePath.relative(base, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("The source attachment path escapes the Scient source store.");
  }
  return resolved;
}

function zoteroSyncPath(paths: SourceStorePaths, sourceId: string): string {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.zotero, `${sourceId}.json`);
}

/** The Zotero values a source was last synced from, or null before its first sync. */
export async function readScientSourceZoteroSync(
  root: ScientSourceStoreLocation,
  sourceId: string,
): Promise<ScientSourceZoteroSyncType | null> {
  const paths = await sourceStorePaths(root);
  const filePath = zoteroSyncPath(paths, sourceId);
  if ((await snapshot(filePath)) === "missing") return null;
  // A damaged sync file only loses the merge base; refresh then treats every difference as new.
  return readBoundedJson(filePath, MAX_RECORD_BYTES, ScientSourceZoteroSync).catch(() => null);
}

export async function writeScientSourceZoteroSync(
  root: ScientSourceStoreLocation,
  state: ScientSourceZoteroSyncType,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  await asLibraryWriter(paths, () =>
    atomicWriteJson(zoteroSyncPath(paths, state.sourceId), state, MAX_RECORD_BYTES),
  );
}

/** Replaces a source's links to other reference managers, as a new revision. */
export async function updateScientSourceExternalReferences(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly externalReferences: ReadonlyArray<ScientSourceExternalReference>;
  readonly actor?: ScientSourceActor;
}): Promise<{
  readonly outcome: "updated" | "unchanged" | "stale";
  readonly record: ScientSourceRecord;
}> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    if (JSON.stringify(current.externalReferences) === JSON.stringify(input.externalReferences)) {
      return { outcome: "unchanged", record: current };
    }
    if (current.revision !== input.expectedRevision) return { outcome: "stale", record: current };
    const next: ScientSourceRecord = {
      ...current,
      externalReferences: [...input.externalReferences],
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    await persistSourceRevision(paths, current, next);
    return { outcome: "updated", record: next };
  });
}

/** For sibling store modules (collections, reviews) that share this store's safety rules. */
export const scientSourceStoreInternals = {
  sourceStorePaths,
  readSourceRecordFromPaths,
  readScientSourceRecordIfPresent,
  listScientSourceRecordsFromPaths,
  persistSourceRevision,
  moveRecordToTrash,
  restoreTrashedRecord,
  readTrashEntry,
  zoteroSyncPath,
  maxRecordBytes: MAX_RECORD_BYTES,
  withStoreLock,
  asLibraryWriter,
  snapshot,
  readBoundedJson,
  atomicWriteJson,
  atomicCreateJson,
  withOperationLock,
  assertSafeIdentifier,
};
