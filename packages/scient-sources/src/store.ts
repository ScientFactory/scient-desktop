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
  carryScientSourceIntakeIndex,
  sourceMetadataMatchIndex,
  type ScientSourceIntakeExclusions,
} from "./duplicates.ts";
import { refreshFolderIndex, type FolderIndex, type IndexedFile } from "./folderIndex.ts";
import { readScientLibraryExclusions, type ScientLibraryExclusions } from "./libraryExclusions.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  isScientLibraryLocation,
  readScientLibraryManifest,
  scientLibraryLocation,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "./libraryRoot.ts";
import {
  assertScientProjectDirectory,
  resolveScientProjectFile,
  scientSourcePdfMaterialPaths,
} from "./projectFiles.ts";
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
  type ScientSourceItemCitationKey,
  type ScientSourceNotBrought,
  ScientSourceRecordV1,
  type ScientSourceRecord,
  ScientSourceStagedMaterial,
  ScientSourceType,
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
import { summarizeNotBrought } from "./notBrought.ts";
import { normalizeScientSourceMore } from "./sourceMore.ts";

export const SCIENT_SOURCES_DIRECTORY = ".scient/sources";
export const SCIENT_SOURCE_RECORDS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/records`;
export const SCIENT_SOURCE_FILES_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/files/sha256`;
/** Kept revisions per source, counting the first one, which is never pruned. */
export const SCIENT_SOURCE_HISTORY_LIMIT = 50;
/** In the library, Zotero merge bases sit at `zotero/`; every other folder keeps its project name. */
const SCIENT_LIBRARY_ZOTERO_SYNC_DIRECTORY = "zotero";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_TRASH_ENTRY_BYTES = MAX_RECORD_BYTES + 64 * 1024;

/** The library folder of tombstones, one `<sourceId>.json` per source deleted for good. */
const SCIENT_LIBRARY_DELETED_DIRECTORY = "deleted";
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_STAGED_MATERIAL_BYTES = 2 * 1024 * 1024;
const operationLocks = new Map<string, Promise<unknown>>();
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

/** The record a candidate is certainly the same work as, when it lacks this PDF. */
function sameWorkWithoutPdf(
  duplicate: ScientSourceDuplicateAssessment,
  existing: ReadonlyArray<ScientSourceRecord>,
  pdfSha256: string | undefined,
): ScientSourceRecord | null {
  if (duplicate.kind === "new" || duplicate.kind === "possible-metadata-match" || !pdfSha256) {
    return null;
  }
  const record = existing.find((entry) => entry.sourceId === duplicate.matchingSourceIds[0]);
  return record && !record.attachments.some((entry) => entry.sha256 === pdfSha256) ? record : null;
}

/** `attached`: the work was here already, and the PDF was added to `record`. */
export interface ImportedOrAttachedSourceResult extends Omit<ImportedSourceResult, "outcome"> {
  readonly outcome: ImportedSourceResult["outcome"] | "attached";
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
  /** Library only: what was deleted for good, so no project snapshot brings it back. */
  readonly deleted: string;
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
    deleted: NodePath.join(base, SCIENT_LIBRARY_DELETED_DIRECTORY),
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

async function readSourceHistoryRecords(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  const directory = NodePath.dirname(sourceHistoryPath(paths, sourceId, 1));
  const state = await snapshot(directory);
  if (state === "missing") return [];
  if (state !== "directory") throw new Error("The source revision history is unsafe.");
  await assertScientProjectDirectory(paths.root, directory);

  const records: ScientSourceRecord[] = [];
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
    records.push(record);
  }
  return records;
}

async function latestSourceHistoryRevision(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<number> {
  let latestRevision = 0;
  for (const record of await readSourceHistoryRecords(paths, sourceId)) {
    latestRevision = Math.max(latestRevision, record.revision);
  }
  return latestRevision;
}

const isScientSourceType = Schema.is(ScientSourceType);

/** A record whose type the store cannot read back is refused, never written. */
function assertStorableSourceType(type: unknown): void {
  if (!isScientSourceType(type)) {
    throw new Error(
      `The source type “${String(type)}” is not one Scient knows, so the source was not saved.`,
    );
  }
}

/** A revision written after `current` is kept, so no unkept note saves lead up to it. */
function keptRevision(record: ScientSourceRecord): ScientSourceRecord {
  const { noteOnlySince: _noteOnlySince, ...kept } = record;
  return kept;
}

async function persistSourceRevision(
  paths: SourceStorePaths,
  current: ScientSourceRecord,
  next: ScientSourceRecord,
): Promise<void> {
  assertStorableSourceType(next.type);
  await preserveSourceRevision(paths, current);
  await atomicWriteJson(
    sourceRecordPath(paths, current.sourceId),
    keptRevision(next),
    MAX_RECORD_BYTES,
  );
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
  /** Written in the same revision as the details, when they change. */
  readonly note?: string | null;
  readonly externalReferences?: ReadonlyArray<ScientSourceExternalReference>;
  readonly attachments?: ReadonlyArray<ScientSourceAttachment>;
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
  persist: (current: ScientSourceRecord, next: ScientSourceRecord) => Promise<void> = async (
    current,
    next,
  ) => persistSourceRevision(paths, current, next),
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
  const next = {
    ...updated,
    ...(input.fieldProvenance ? { fieldProvenance: [...input.fieldProvenance] } : {}),
    ...(input.note !== undefined ? { note: normalizeScientSourceNote(input.note) } : {}),
    ...(input.externalReferences ? { externalReferences: [...input.externalReferences] } : {}),
    ...(input.attachments?.length
      ? { attachments: [...current.attachments, ...input.attachments] }
      : {}),
  };
  await persist(current, next);
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
  /** Absent for a source whose identifier was never checked, when only its notices change. */
  readonly verification?: ScientSourceVerification;
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
      ...(input.verification ? { verification: input.verification } : {}),
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

/** One editor's autosaves of a note within this window are one version. */
const NOTE_SESSION_WINDOW_MS = 10 * 60 * 1000;
/** Per source, the editing session that wrote its current revision, and when that began. */
const noteSessions = new Map<
  string,
  {
    readonly session: string;
    readonly revision: number;
    readonly updatedAt: string;
    readonly since: number;
  }
>();

export async function updateScientSourceNote(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly note: string | null;
  readonly expectedNote?: string | null;
  readonly actor?: ScientSourceActor;
  /** An editor's autosave session: its saves within ten minutes update one version in place. */
  readonly session?: string;
}): Promise<ScientSourceNoteUpdateResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  const note = normalizeScientSourceNote(input.note);

  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    if ((current.note ?? null) === note) {
      return { outcome: "unchanged", record: current };
    }
    if (
      input.expectedNote !== undefined
        ? normalizeScientSourceNote(current.note ?? null) !==
          normalizeScientSourceNote(input.expectedNote)
        : current.revision !== input.expectedRevision
    ) {
      return { outcome: "stale", record: current };
    }

    const key = `${paths.root}\0${input.sourceId}`;
    const known = noteSessions.get(key);
    const now = Date.now();
    // Nothing else wrote a revision since this session's last save, and none was kept of it.
    const continuing =
      input.session !== undefined &&
      known?.session === input.session &&
      known.revision === current.revision &&
      known.updatedAt === current.updatedAt &&
      now - known.since < NOTE_SESSION_WINDOW_MS &&
      (await snapshot(sourceHistoryPath(paths, current.sourceId, current.revision))) === "missing";
    // Every save is a revision, so a revision-checked writer never replaces a newer note; the
    // session's earlier saves are just not kept, and `noteOnlySince` says so to history readers.
    const next: ScientSourceRecord = {
      ...current,
      note,
      revision: current.revision + 1,
      ...(continuing ? { noteOnlySince: current.noteOnlySince ?? current.revision } : {}),
      updatedAt: new Date(now).toISOString(),
      updatedBy: input.actor ?? "user",
    };
    if (continuing) {
      await atomicWriteJson(sourceRecordPath(paths, current.sourceId), next, MAX_RECORD_BYTES);
    } else {
      await persistSourceRevision(paths, current, next);
    }
    if (input.session === undefined) {
      noteSessions.delete(key);
    } else {
      noteSessions.set(key, {
        session: input.session,
        revision: next.revision,
        updatedAt: next.updatedAt!,
        since: continuing ? known!.since : now,
      });
    }
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
    removalId: NodeCrypto.randomUUID(),
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
    ...keptRevision(entry.record),
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
  // Reading state changes without a revision: a star since this copy was kept is no conflict.
  const versioned = (value: ScientSourceRecord) =>
    JSON.stringify({ ...value, readingStatus: undefined, starred: undefined });
  if (versioned(await readBoundedSourceRecord(historyPath)) !== versioned(record)) {
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

type TrashFileResult =
  | { readonly entry: ScientSourceTrashEntry | null }
  | { readonly issue: ScientSourceStoreIssue };

/** Derived from the Trash files and rebuilt from them, by Trash folder. */
const trashIndexes = new Map<string, FolderIndex<TrashFileResult>>();

/** Only new or changed Trash files are read again; see `refreshFolderIndex`. */
async function indexTrash(paths: SourceStorePaths): Promise<FolderIndex<TrashFileResult> | null> {
  const index = await refreshFolderIndex<TrashFileResult>({
    folder: paths.trash,
    previous: trashIndexes.get(paths.trash),
    read: async (name) => {
      try {
        return { entry: await readTrashEntry(paths, name.slice(0, -".json".length)) };
      } catch (error) {
        const filePath = NodePath.join(paths.trash, name);
        return {
          issue: { path: projectRelativePath(paths, filePath), message: issueMessage(error) },
        };
      }
    },
    unsafe: (filePath) => ({
      issue: { path: projectRelativePath(paths, filePath), message: UNSAFE_ENTRY_MESSAGE },
    }),
    unsafeFolderMessage: "The Scient source trash is unsafe.",
  });
  if (index) trashIndexes.set(paths.trash, index);
  else trashIndexes.delete(paths.trash);
  return index;
}

function tombstonePath(paths: SourceStorePaths, sourceId: string): string {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.deleted, `${sourceId}.json`);
}

/**
 * Names one removal: no other entry, now or after the source is imported and trashed again, has
 * it. An entry written before removals had IDs is named by its removal time and revision.
 */
export function scientSourceRemovalId(
  entry: Pick<ScientSourceTrashEntry, "sourceId" | "removalId" | "removedAt"> & {
    readonly record: Pick<ScientSourceRecord, "revision">;
  },
): string {
  if (entry.removalId) return entry.removalId;
  return `legacy-${NodeCrypto.createHash("sha256")
    .update(`${entry.sourceId}\0${entry.removedAt}\0${entry.record.revision}`)
    .digest("base64url")
    .slice(0, 32)}`;
}

const DeletionMarker = Schema.Struct({
  sourceId: Schema.String,
  removalId: Schema.optionalKey(Schema.String),
  removedAt: Schema.String,
  record: Schema.Struct({ revision: Schema.Number }),
});
const decodeDeletionMarker = Schema.decodeUnknownSync(DeletionMarker);

/**
 * Whether a permanent deletion began on this trashed copy and has not finished: its tombstone is
 * written first and its trash entry goes last. The tombstone carries the copy's removal ID, so a
 * later copy trashed under the same source ID is never taken for it.
 */
async function deletionStartedOn(
  paths: SourceStorePaths,
  entry: ScientSourceTrashEntry,
): Promise<boolean> {
  if (paths.owner.kind !== "library") return false;
  const filePath = tombstonePath(paths, entry.sourceId);
  if ((await snapshot(filePath)) === "missing") return false;
  try {
    const marker = decodeDeletionMarker(
      await readBoundedJson(filePath, MAX_TRASH_ENTRY_BYTES, Schema.Unknown),
    );
    return scientSourceRemovalId(marker) === scientSourceRemovalId(entry);
  } catch {
    // An unreadable tombstone began nothing: the entry stays listed, to delete again.
    return false;
  }
}

/** The IDs with a tombstone, listed once for a whole Trash listing. */
async function tombstonedIds(paths: SourceStorePaths): Promise<ReadonlySet<string>> {
  if (paths.owner.kind !== "library" || (await snapshot(paths.deleted)) !== "directory") {
    return new Set();
  }
  return new Set(
    (await NodeFSP.readdir(paths.deleted))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length)),
  );
}

async function scanTrash(
  paths: SourceStorePaths,
  /** The IDs with a record file, when the caller has just listed them. */
  live?: ReadonlySet<string>,
): Promise<{
  readonly entries: ReadonlyArray<ScientSourceTrashEntry>;
  /** Entries whose permanent deletion stopped part way; never listed or restored. */
  readonly deleting: ReadonlyArray<ScientSourceTrashEntry>;
  readonly issues: ReadonlyArray<ScientSourceStoreIssue>;
}> {
  const index = await indexTrash(paths);
  if (!index) return { entries: [], deleting: [], issues: [] };
  const { entries: listed, issues } = trashListingOf(index);
  // A live record with the same ID means a removal stopped before deleting it.
  let present: ReadonlyArray<ScientSourceTrashEntry>;
  if (live) present = listed.filter((entry) => !live.has(entry.sourceId));
  else {
    const missing: boolean[] = [];
    for (let start = 0; start < listed.length; start += TRASH_LIVE_CHECK_CONCURRENCY) {
      const part = listed.slice(start, start + TRASH_LIVE_CHECK_CONCURRENCY);
      for (const state of await Promise.all(
        part.map((entry) => snapshot(sourceRecordPath(paths, entry.sourceId))),
      )) {
        missing.push(state === "missing");
      }
    }
    present = listed.filter((_, position) => missing[position]);
  }
  const tombstoned = await tombstonedIds(paths);
  const begun = new Set<ScientSourceTrashEntry>();
  for (const entry of present.filter(({ sourceId }) => tombstoned.has(sourceId))) {
    if (await deletionStartedOn(paths, entry)) begun.add(entry);
  }
  return {
    entries: present.filter((entry) => !begun.has(entry)),
    deleting: [...begun],
    issues,
  };
}

const TRASH_LIVE_CHECK_CONCURRENCY = 32;

const trashListings = new WeakMap<
  FolderIndex<TrashFileResult>,
  {
    readonly entries: ReadonlyArray<ScientSourceTrashEntry>;
    readonly issues: ReadonlyArray<ScientSourceStoreIssue>;
  }
>();

/** The index's entries, newest removal first, and its unreadable files; worked out once. */
function trashListingOf(index: FolderIndex<TrashFileResult>) {
  const known = trashListings.get(index);
  if (known) return known;
  const entries: ScientSourceTrashEntry[] = [];
  const issues: ScientSourceStoreIssue[] = [];
  for (const { value } of index.files.values()) {
    if ("issue" in value) issues.push(value.issue);
    else if (value.entry) entries.push(value.entry);
  }
  const listing = {
    entries: entries.toSorted((left, right) => right.removedAt.localeCompare(left.removedAt)),
    issues,
  };
  trashListings.set(index, listing);
  return listing;
}

/**
 * A source deleted for good, kept as its trash entry with the record cut to what identifies the
 * work: no abstract, note, PDFs or history. Hydration and the move treat it as removed.
 */
function tombstoneOf(entry: ScientSourceTrashEntry) {
  const { note: _note, abstractSections: _sections, ...record } = entry.record;
  return {
    ...entry,
    deletedAt: new Date().toISOString(),
    record: { ...record, abstract: null, attachments: [], fieldProvenance: [] },
  };
}

/** Tombstones of a library's sources deleted for good; unreadable files are skipped. */
export async function readScientSourceTombstones(
  root: ScientSourceStoreLocation,
): Promise<ReadonlyArray<ScientSourceTrashEntry>> {
  const paths = await sourceStorePaths(root);
  if ((await snapshot(paths.deleted)) !== "directory") return [];
  const entries: ScientSourceTrashEntry[] = [];
  for (const file of await NodeFSP.readdir(paths.deleted, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      entries.push(
        decodePersistedTrashEntry(
          await readBoundedJson(
            NodePath.join(paths.deleted, file.name),
            MAX_TRASH_ENTRY_BYTES,
            Schema.Unknown,
          ),
        ),
      );
    } catch {
      // One damaged tombstone must not hide the others.
    }
  }
  return entries;
}

/** Whole trashed records, newest removal first, for callers that need more than the summary. */
export async function readScientSourceTrashEntries(
  root: ScientSourceStoreLocation,
): Promise<ReadonlyArray<ScientSourceTrashEntry>> {
  return (await scanTrash(await sourceStorePaths(root))).entries;
}

/**
 * What a person moved to the Trash. A copy a merge took away is kept there for the merge's Undo
 * only: it is not listed, counted or emptied, and goes when the paper it joined is deleted.
 */
function removedByPerson(
  entries: ReadonlyArray<ScientSourceTrashEntry>,
): ReadonlyArray<ScientSourceTrashEntry> {
  return entries.filter((entry) => !entry.mergedInto);
}

/** What the overview says of the Trash: what a person removed, and deletions left unfinished. */
function trashCountsOf(trash: {
  readonly entries: ReadonlyArray<ScientSourceTrashEntry>;
  readonly deleting: ReadonlyArray<ScientSourceTrashEntry>;
}): { readonly trashedCount?: number; readonly unfinishedDeletions?: number } {
  const count = removedByPerson(trash.entries).length;
  return {
    ...(count > 0 ? { trashedCount: count } : {}),
    ...(trash.deleting.length > 0 ? { unfinishedDeletions: trash.deleting.length } : {}),
  };
}

/** The Trash as a person or an agent is shown it: what was removed, without merges' copies. */
export async function readScientSourcesRemovedByPerson(
  root: ScientSourceStoreLocation,
  /** The IDs with a record file (`listScientSourceIds`), when the caller has them. */
  live?: ReadonlySet<string>,
): Promise<ReadonlyArray<ScientSourceTrashEntry>> {
  return removedByPerson((await scanTrash(await sourceStorePaths(root), live)).entries);
}

/**
 * The chosen entries and every copy merged into them, directly or through another, copies
 * first: a deletion stopped part way leaves the chosen entry in the Trash to delete again.
 */
function withCopiesMergedInto(
  all: ReadonlyArray<ScientSourceTrashEntry>,
  chosen: ReadonlyArray<ScientSourceTrashEntry>,
): ReadonlyArray<ScientSourceTrashEntry> {
  const going = new Map(chosen.map((entry) => [entry.sourceId, entry]));
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of all) {
      if (going.has(entry.sourceId) || !entry.mergedInto) continue;
      if (!going.has(entry.mergedInto.sourceId)) continue;
      going.set(entry.sourceId, entry);
      grew = true;
    }
  }
  return [...going.values()].toReversed();
}

/** What a person is shown of the Trash, as one value: each entry, its revision and removal. */
function trashRevisionOf(entries: ReadonlyArray<ScientSourceTrashEntry>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const entry of removedByPerson(entries).toSorted((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  )) {
    hash.update(`${scientSourceRemovalId(entry)}\n`);
  }
  return hash.digest("base64url");
}

export async function listScientSourceTrash(
  root: ScientSourceStoreLocation,
): Promise<ScientSourceTrashListing> {
  const { entries, deleting, issues } = await scanTrash(await sourceStorePaths(root));
  return {
    revision: trashRevisionOf(entries),
    entries: removedByPerson(entries).map((entry) => ({
      sourceId: entry.record.sourceId,
      removalId: scientSourceRemovalId(entry),
      revision: entry.record.revision,
      type: entry.record.type,
      title: entry.record.title,
      creators: entry.record.creators,
      issuedYear: entry.record.issuedYear,
      removedAt: entry.removedAt,
      removedBy: entry.removedBy,
    })),
    issues,
    ...(deleting.length > 0 ? { unfinished: deleting.map(scientSourceRemovalId) } : {}),
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
    if (!entry || (await deletionStartedOn(paths, entry))) {
      return { outcome: "not-found", ...empty };
    }
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
 * Deletes trashed sources and their history, then every PDF no live or trashed source attaches.
 * Named removals go as named; omitting them empties the trash, only while it is still the
 * listing `trashRevision` names. Deletions that stopped part way are finished either way. A
 * collected PDF's extracted text and annotations are removed after its bytes are unlinked.
 */
export async function deleteScientSourcesPermanently(input: {
  readonly root: ScientSourceStoreLocation;
  /** `removalId`s of Trash entries; a removal that is gone matches nothing. */
  readonly removalIds?: ReadonlyArray<string>;
  /** The `revision` of the Trash listing the person confirmed emptying. */
  readonly trashRevision?: string;
}): Promise<ScientSourcePermanentDeletionResult> {
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, "source-write", async () => {
    const { entries, deleting } = await scanTrash(paths);
    if (!input.removalIds && input.trashRevision !== trashRevisionOf(entries)) {
      return { outcome: "changed", deletedSourceIds: [], removedFileCount: 0 };
    }
    const selected = input.removalIds ? new Set(input.removalIds) : null;
    const chosen = selected
      ? entries.filter((entry) => selected.has(scientSourceRemovalId(entry)))
      : removedByPerson(entries);
    return deleteTrashEntries(paths, deleting, withCopiesMergedInto(entries, chosen));
  });
}

export type ScientTrashedSourceDeletionResult =
  | { readonly outcome: "deleted"; readonly sourceId: string; readonly removedFileCount: number }
  | { readonly outcome: "stale"; readonly sourceId: string; readonly revision: number }
  | { readonly outcome: "not-found"; readonly sourceId: string };

/**
 * Deletes one trashed source for good only if it is still the removal the caller saw. The
 * comparison runs under the same lock as the deletion, so a restore and second removal, or a
 * deletion for good and a new import, in between can never let an old request delete the newer
 * copy.
 */
export async function deleteTrashedScientSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  /** The entry's `removalId`, from the Trash listing. */
  readonly removalId: string;
}): Promise<ScientTrashedSourceDeletionResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const { entries, deleting } = await scanTrash(paths);
    const trashed = entries.find((candidate) => candidate.sourceId === input.sourceId);
    // A deletion of this copy that stopped part way is finished by asking again.
    const entry = trashed ?? deleting.find((begun) => begun.sourceId === input.sourceId);
    if (!entry) return { outcome: "not-found", sourceId: input.sourceId };
    if (scientSourceRemovalId(entry) !== input.removalId) {
      return { outcome: "stale", sourceId: input.sourceId, revision: entry.record.revision };
    }
    const { removedFileCount } = await deleteTrashEntries(
      paths,
      deleting,
      trashed ? withCopiesMergedInto(entries, [trashed]) : [],
    );
    return { outcome: "deleted", sourceId: input.sourceId, removedFileCount };
  });
}

/** Caller holds the source-write lock. */
async function deleteTrashEntries(
  paths: SourceStorePaths,
  /** Deletions that stopped part way, finished first. */
  resumed: ReadonlyArray<ScientSourceTrashEntry>,
  entries: ReadonlyArray<ScientSourceTrashEntry>,
): Promise<ScientSourcePermanentDeletionResult> {
  // The tombstone lands first and marks the deletion as begun; the trash entry goes last, so a
  // deletion that stops part way is found and finished by the next one.
  if (paths.owner.kind === "library") {
    for (const entry of entries) {
      await atomicWriteJson(
        tombstonePath(paths, entry.sourceId),
        tombstoneOf(entry),
        MAX_TRASH_ENTRY_BYTES,
      );
    }
  }
  const going = [...resumed, ...entries];
  for (const entry of going) {
    await NodeFSP.rm(zoteroSyncPath(paths, entry.sourceId), { force: true });
    await NodeFSP.rm(zoteroSyncPendingPath(paths, entry.sourceId), { force: true });
    await NodeFSP.rm(NodePath.dirname(sourceHistoryPath(paths, entry.sourceId, 1)), {
      recursive: true,
      force: true,
    });
  }
  const goingIds = new Set(going.map((entry) => entry.sourceId));
  const collect = () => collectUnreferencedSourceFiles(paths, goingIds, going.length > 0);
  const removeEntries = async () => {
    for (const entry of going) {
      await NodeFSP.rm(trashEntryPath(paths, entry.sourceId), { force: true });
    }
  };
  // A project store has no tombstone to mark the deletion, so its entries go before collection:
  // an entry left in its trash stays restorable with its PDFs.
  let removedFileCount: number;
  if (paths.owner.kind === "library") {
    removedFileCount = await collect();
    await removeEntries();
  } else {
    await removeEntries();
    removedFileCount = await collect();
  }
  return {
    outcome: "deleted",
    deletedSourceIds: going.map((entry) => entry.sourceId),
    removedFileCount,
  };
}

/**
 * Removes every PDF no live record and no remaining trash entry attaches. Saved versions keep
 * none: a restore never brings a PDF back. Caller holds the source-write lock; prepared package
 * blobs are rechecked when attached.
 */
async function collectUnreferencedSourceFiles(
  paths: SourceStorePaths,
  /** Trash entries being deleted, which no longer keep a file. */
  going: ReadonlySet<string>,
  /** False when nothing is deleted: only material left from an earlier collection is retried. */
  collectPdfs: boolean,
): Promise<number> {
  const pending = await pendingMaterialHashes(paths);
  if (!collectPdfs && pending.length === 0) return 0;
  const live = await scanScientSourceRecords(paths);
  const trash = await scanTrash(paths);
  // An unreadable record may still refer to a file; deleting nothing is the safe answer.
  if (live.issues.length > 0 || trash.issues.length > 0) return 0;
  const attachments = [
    ...live.records,
    ...trash.entries.filter((entry) => !going.has(entry.sourceId)).map((entry) => entry.record),
  ].flatMap((record) => record.attachments);
  const referenced = new Set(attachments.map((attachment) => attachment.relativePath));
  const referencedHashes = new Set(attachments.map((attachment) => attachment.sha256));
  const removed = collectPdfs
    ? await collectUnreferencedPdfs(paths, referenced, referencedHashes)
    : 0;
  for (const sha256 of await pendingMaterialHashes(paths)) {
    await finishCollectedMaterial(paths, sha256, referencedHashes);
  }
  return removed;
}

async function collectUnreferencedPdfs(
  paths: SourceStorePaths,
  referenced: ReadonlySet<string>,
  referencedHashes: ReadonlySet<string>,
): Promise<number> {
  try {
    await assertScientProjectDirectory(paths.root, paths.files);
  } catch {
    return 0;
  }
  let removed = 0;
  let failure: unknown;
  for (const prefix of await NodeFSP.readdir(paths.files, { withFileTypes: true })) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
    const directory = NodePath.join(paths.files, prefix.name);
    for (const file of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (
        !file.isFile() ||
        !/^[a-f0-9]{64}\.pdf$/u.test(file.name) ||
        !file.name.startsWith(prefix.name)
      ) {
        continue;
      }
      const relativePath = NodePath.posix.join("files", "sha256", prefix.name, file.name);
      if (referenced.has(relativePath)) continue;
      const sha256 = file.name.slice(0, -".pdf".length);
      try {
        // Noted before the bytes go, so the text and highlights are removed even after a failure.
        if (!referencedHashes.has(sha256)) {
          await atomicWriteJson(pendingMaterialPath(paths, sha256), { sha256 }, MAX_POINTER_BYTES);
        }
        await NodeFSP.unlink(NodePath.join(directory, file.name));
        removed += 1;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) failure ??= error;
      }
    }
    await NodeFSP.rmdir(directory).catch(() => undefined);
  }
  // The rest are collected; the deletion stays unfinished, so finishing it collects this one.
  if (failure !== undefined) throw failure;
  return removed;
}

/** Where a collected PDF's hash waits until its extracted text and highlights are gone. */
function pendingMaterialPath(paths: SourceStorePaths, sha256: string): string {
  return NodePath.join(paths.base, "collected", `${sha256}.json`);
}

async function pendingMaterialHashes(paths: SourceStorePaths): Promise<ReadonlyArray<string>> {
  const directory = NodePath.dirname(pendingMaterialPath(paths, "0".repeat(64)));
  try {
    await assertScientProjectDirectory(paths.root, directory);
    return (await NodeFSP.readdir(directory)).flatMap((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name) ? [name.slice(0, -".json".length)] : [],
    );
  } catch {
    return [];
  }
}

/** Caller holds the source-write lock; the note goes once the material is gone or used again. */
async function finishCollectedMaterial(
  paths: SourceStorePaths,
  sha256: string,
  referencedHashes: ReadonlySet<string>,
): Promise<void> {
  const note = pendingMaterialPath(paths, sha256);
  const pdf = NodePath.join(paths.files, sha256.slice(0, 2), `${sha256}.pdf`);
  // A PDF that could not be unlinked is collected, and this retried, by a later deletion.
  if (!referencedHashes.has(sha256) && (await snapshot(pdf)) !== "missing") return;
  if (!referencedHashes.has(sha256) && !(await removeCollectedPdfMaterial(paths, sha256))) return;
  await NodeFSP.rm(note, { force: true });
  await NodeFSP.rmdir(NodePath.dirname(note)).catch(() => undefined);
}

/** Whether none of this PDF's material is left; unsafe or unavailable material is retained. */
async function removeCollectedPdfMaterial(
  paths: SourceStorePaths,
  sha256: string,
): Promise<boolean> {
  let removed = true;
  for (const filePath of Object.values(scientSourcePdfMaterialPaths(paths.location, sha256))) {
    try {
      await assertScientProjectDirectory(paths.root, NodePath.dirname(filePath));
      const state = await snapshot(filePath);
      if (state === "file") await NodeFSP.unlink(filePath);
      // A link or folder in its place is retained, never followed.
      else if (state !== "missing") removed = false;
    } catch (error) {
      // Material that was never there needs no removal.
      if (!isNodeError(error, "ENOENT")) removed = false;
    }
  }
  return removed;
}

// Reading state is about the person, not a revision of the source: never listed or reverted.
const REVERT_IGNORED_FIELDS = new Set([
  "revision",
  "noteOnlySince",
  "updatedAt",
  "updatedBy",
  "readingStatus",
  "starred",
]);
const UNLISTED_CHANGE_FIELDS = new Set(["fieldProvenance", "hydratedCitationFields"]);

/**
 * What a revert keeps as it is now: what identifies the source, the citation key documents may
 * already cite, and what is the person's rather than the paper's details: the note and the PDFs.
 */
function revertPreservedFields(
  current: ScientSourceRecord,
): Pick<
  ScientSourceRecord,
  | "formatVersion"
  | "sourceId"
  | "projectId"
  | "importedAt"
  | "origin"
  | "citationKey"
  | "note"
  | "attachments"
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
    ...(current.note !== undefined ? { note: current.note } : {}),
    attachments: current.attachments,
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

/**
 * A live source as it was at each kept revision after `revision`, oldest first and ending with
 * now; null when the source is gone or a revision in between cannot be read or is no longer kept,
 * unless it was a note save of a typing session. Only the revisions in between are read.
 */
export async function readScientSourceRecordsAfter(
  root: ScientSourceStoreLocation,
  sourceId: string,
  revision: number,
): Promise<ReadonlyArray<ScientSourceRecord> | null> {
  const paths = await sourceStorePaths(root);
  const current = await readScientSourceRecordIfPresent(paths, sourceId);
  if (!current) return null;
  const wanted = (await sourceHistoryRevisions(paths, sourceId)).filter(
    (kept) => kept > revision && kept < current.revision,
  );
  const between: ScientSourceRecord[] = [];
  for (const kept of wanted) {
    const record = await readBoundedSourceRecord(sourceHistoryPath(paths, sourceId, kept)).catch(
      () => null,
    );
    if (!record || record.sourceId !== sourceId || record.revision !== kept) return null;
    between.push(record);
  }
  const read = [...between, current];
  // A revision not kept is known only when a later one says it changed nothing but the note.
  for (let missing = revision + 1; missing < current.revision; missing += 1) {
    if (wanted.includes(missing)) continue;
    const covered = read.some(
      (record) =>
        record.noteOnlySince !== undefined &&
        record.noteOnlySince <= missing &&
        missing < record.revision,
    );
    if (!covered) return null;
  }
  return read;
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

/** Makes an earlier revision's details current again as a new revision. */
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
    const unchanged = { record: current, matchingSourceIds: [] };
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
    const {
      revision: _revision,
      updatedAt: _updatedAt,
      updatedBy: _updatedBy,
      origin: _origin,
      citationKey: _citationKey,
      note: _note,
      ...content
    } = target;
    const next: ScientSourceRecord = {
      ...content,
      ...revertPreservedFields(current),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actor ?? "user",
    };
    if (changedRevisionFields(current, next).length === 0) {
      return { outcome: "unchanged", ...unchanged };
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
    return { outcome: "reverted", record: next, matchingSourceIds: [] };
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

interface LibraryRecordIndex extends RecordScan, FolderIndex<RecordFileResult> {}

/** Derived from the record files and rebuilt from them; the files stay the truth. */
const libraryRecordIndexes = new Map<string, LibraryRecordIndex>();

/** A first build of a library's index in progress; it settles, never rejects. */
const libraryRecordIndexBuilds = new Map<string, Promise<void>>();

/**
 * The library's record list from its in-memory index. A list asked for while the first build
 * runs (the start-up warming, or another list) waits for that build and then checks it as below,
 * instead of reading every record a second time.
 */
async function scanLibraryRecords(
  paths: SourceStorePaths,
  signal?: AbortSignal,
): Promise<RecordScan> {
  if (!libraryRecordIndexes.has(paths.root)) {
    const building = libraryRecordIndexBuilds.get(paths.root);
    if (building) {
      await building;
    } else {
      const build = indexLibraryRecords(paths, signal);
      const settled = build.then(
        () => undefined,
        () => undefined,
      );
      libraryRecordIndexBuilds.set(paths.root, settled);
      void settled.then(() => {
        if (libraryRecordIndexBuilds.get(paths.root) === settled) {
          libraryRecordIndexBuilds.delete(paths.root);
        }
      });
      return build;
    }
  }
  return indexLibraryRecords(paths, signal);
}

/** Only new or changed record files are read again; see `refreshFolderIndex`. */
async function indexLibraryRecords(
  paths: SourceStorePaths,
  signal: AbortSignal | undefined,
): Promise<RecordScan> {
  const cached = libraryRecordIndexes.get(paths.root);
  const folder = await refreshFolderIndex<RecordFileResult>({
    folder: paths.records,
    previous: cached,
    read: (name) => readRecordFile(paths, name),
    unsafe: (filePath) => ({
      issue: { path: projectRelativePath(paths, filePath), message: UNSAFE_ENTRY_MESSAGE },
    }),
    unsafeFolderMessage: "The Scient source record store is unsafe.",
    signal,
  });
  if (!folder) {
    libraryRecordIndexes.delete(paths.root);
    return { records: [], issues: [] };
  }
  if (folder === cached) return cached;
  const index: LibraryRecordIndex = {
    ...settleScan([...folder.files.values()].map((file) => file.value)),
    ...folder,
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

/**
 * Builds a library's record index before its first list, only when it holds at least
 * `minimumRecords` record files. Counting lists one folder and reads no record; `signal` stops
 * the build between reads and leaves no index behind.
 */
export async function warmScientLibraryRecordIndex(
  location: ScientLibraryLocation,
  options: { readonly minimumRecords: number; readonly signal?: AbortSignal },
): Promise<{ readonly recordFiles: number; readonly warmed: boolean }> {
  const names = await NodeFSP.readdir(NodePath.join(location.root, "records")).catch(
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    },
  );
  const recordFiles = names.filter((name) => name.endsWith(".json")).length;
  if (recordFiles < options.minimumRecords) return { recordFiles, warmed: false };
  await scanLibraryRecords(await sourceStorePaths(location), options.signal);
  return { recordFiles, warmed: true };
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

/**
 * The parts of one import, in order. A scope too large for one operation is imported as a
 * run: the first part has the run's ID and part N is `<runId>-N`, so the parts on disk are
 * the record of the run. Any other import is its one part.
 */
export async function readSourceImportParts(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<ReadonlyArray<ScientSourceImportOperation>> {
  const paths = await sourceStorePaths(root);
  const first = await readSourceImportOperationFromPaths(paths, operationId);
  if (!first) return [];
  const parts = [first];
  for (let part = 2; first.run; part += 1) {
    const next = await readSourceImportOperationFromPaths(paths, `${operationId}-${part}`);
    if (next?.run?.runId !== operationId) break;
    parts.push(next);
  }
  return parts;
}

/** An import's parts as one: every item, what the first part passed by, the last part's state. */
export function wholeSourceImport(
  parts: ReadonlyArray<ScientSourceImportOperation>,
): ScientSourceImportOperation | null {
  const [first] = parts;
  const last = parts.at(-1);
  if (!first || !last) return null;
  if (parts.length === 1) return first;
  const { notBrought: _, ...latest } = last;
  // A reference a later part took again (after a stop, or a failure tried again) counts once,
  // as that later part left it.
  const items = new Map(parts.flatMap((part) => part.items.map((item) => [item.itemKey, item])));
  return {
    ...latest,
    operationId: first.operationId,
    items: [...items.values()],
    ...(first.notBrought ? { notBrought: first.notBrought } : {}),
  };
}

/** Records that a run has nothing more to bring (what remained is no longer in the scope). */
export async function endSourceImportRun(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(root);
  return withStoreLock(paths, operationId, async () => {
    const operation = await readSourceImportOperationFromPaths(paths, operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (!operation.run || operation.run.remaining === 0) return operation;
    const ended = { ...operation, run: { ...operation.run, remaining: 0 } };
    await atomicWriteJson(operationPath(paths.operations, operationId), ended, MAX_OPERATION_BYTES);
    return ended;
  });
}

/**
 * One finished import of a file, of Zotero items or of PDFs, as its receipts and operations
 * say. A large import's parts are one import, under the run's ID.
 */
export interface ScientSourceImportSummary {
  readonly operationId: string;
  readonly finishedAt: string;
  readonly by: ScientSourceActor;
  readonly intake: ScientSourceImportOperation["intake"];
  readonly outcome: ScientSourceImportReceipt["outcome"];
  /** The sources it added, by the IDs they had then. */
  readonly importedSourceIds: ReadonlyArray<string>;
  readonly failed: number;
  /** How many kinds of things it read and did not bring. */
  readonly notBrought: number;
  /** A large import that stopped before its end: how many references are still to come. */
  readonly remaining?: number;
}

/** Derived from the receipt files, by receipts folder; a receipt is written once. */
const receiptIndexes = new Map<string, FolderIndex<ScientSourceImportReceipt | null>>();

/**
 * The newest finished imports that added at least one source; reads only. An import whose
 * receipt or operation cannot be read is left out.
 */
export async function listScientSourceImports(
  root: ScientSourceStoreLocation,
  limit: number,
): Promise<ReadonlyArray<ScientSourceImportSummary>> {
  const paths = await sourceStorePaths(root);
  if ((await snapshot(paths.receipts)) !== "directory") return [];
  const index = await refreshFolderIndex<ScientSourceImportReceipt | null>({
    folder: paths.receipts,
    previous: receiptIndexes.get(paths.receipts),
    read: (name) =>
      readBoundedJson(
        NodePath.join(paths.receipts, name),
        MAX_OPERATION_BYTES,
        ScientSourceImportReceipt,
      ).catch(() => null),
    unsafe: () => null,
    unsafeFolderMessage: "The Scient source receipts folder is unsafe.",
  });
  if (index) receiptIndexes.set(paths.receipts, index);
  else receiptIndexes.delete(paths.receipts);
  const receipts = [...(index?.files.values() ?? [])].flatMap(({ value }) =>
    value ? [value] : [],
  );
  // The parts of a large import are one import, dated by its latest part.
  const byImport = new Map<string, ScientSourceImportReceipt[]>();
  for (const receipt of receipts) {
    const id = receipt.runId ?? receipt.operationId;
    byImport.set(id, [...(byImport.get(id) ?? []), receipt]);
  }
  const newest = [...byImport]
    .map(([id, parts]) => ({ id, ...finishedImport(parts) }))
    .filter((entry) => entry.importedSourceIds.length > 0)
    .toSorted(
      (left, right) =>
        right.finishedAt.localeCompare(left.finishedAt) || left.id.localeCompare(right.id),
    )
    .slice(0, limit);
  const imports: ScientSourceImportSummary[] = [];
  for (const entry of newest) {
    const summary = await importSummary(root, entry.id, entry);
    if (summary) imports.push(summary);
  }
  return imports;
}

/** When an import of several receipts finished and how: its latest part's date and outcome. */
function finishedImport(parts: ReadonlyArray<ScientSourceImportReceipt>) {
  const inOrder = parts.toSorted((left, right) => left.finishedAt.localeCompare(right.finishedAt));
  const last = inOrder.at(-1);
  return {
    finishedAt: last?.finishedAt ?? "",
    outcome: last?.outcome ?? ("completed" as const),
    importedSourceIds: inOrder.flatMap((part) => part.importedSourceIds),
  };
}

async function importSummary(
  root: ScientSourceStoreLocation,
  operationId: string,
  finished: ReturnType<typeof finishedImport>,
): Promise<ScientSourceImportSummary | null> {
  const operation = wholeSourceImport(
    await readSourceImportParts(root, operationId).catch(() => []),
  );
  if (!operation) return null;
  // Counted on the parts as one: a failure a later part brought in is not a failure.
  const remaining = operation.state === "running" ? 0 : (operation.run?.remaining ?? 0);
  return {
    operationId,
    finishedAt: finished.finishedAt,
    outcome: finished.outcome,
    importedSourceIds: operation.items.flatMap((item) =>
      item.state === "imported" && item.sourceId ? [item.sourceId] : [],
    ),
    failed: operation.items.filter((item) => item.state === "failed").length,
    by: operation.actor,
    intake: operation.intake,
    notBrought: summarizeNotBrought(operation).length,
    ...(remaining > 0 ? { remaining } : {}),
  };
}

/** One finished import by its operation ID; null when it is not on record. */
export async function readScientSourceImport(
  root: ScientSourceStoreLocation,
  operationId: string,
): Promise<ScientSourceImportSummary | null> {
  assertSafeIdentifier(operationId, "Operation ID");
  const paths = await sourceStorePaths(root);
  const receipts: ScientSourceImportReceipt[] = [];
  for (const part of await readSourceImportParts(root, operationId).catch(() => [])) {
    const filePath = operationPath(paths.receipts, part.operationId);
    if ((await snapshot(filePath)) === "missing") continue;
    const receipt = await readBoundedJson(
      filePath,
      MAX_OPERATION_BYTES,
      ScientSourceImportReceipt,
    ).catch(() => null);
    if (receipt) receipts.push(receipt);
  }
  return receipts.length > 0 ? importSummary(root, operationId, finishedImport(receipts)) : null;
}

/** The IDs of the sources in the store now, from the record files' names; reads no record. */
export async function listScientSourceIds(
  root: ScientSourceStoreLocation,
): Promise<ReadonlySet<string>> {
  const paths = await sourceStorePaths(root);
  if ((await snapshot(paths.records)) !== "directory") return new Set();
  return new Set(
    (await NodeFSP.readdir(paths.records))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length)),
  );
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

/**
 * `operations/active` names the import last made running, written under the `active-operation`
 * lock before that operation; it is active only while it reads back as running. It is a hint:
 * only `alone` (no other import was running when it was written) lets a settled one mean "none
 * running". A pointer without it, from an older version or a store with several, is looked past.
 */
const ActiveOperationPointer = Schema.Struct({
  operationId: Schema.NullOr(Schema.String),
  alone: Schema.optional(Schema.Literal(true)),
});
const MAX_POINTER_BYTES = 4 * 1024;

function activeOperationPointerPath(paths: SourceStorePaths): string {
  return NodePath.join(paths.operations, "active");
}

interface ActiveOperationHint {
  readonly operationId: string | null;
  readonly alone: boolean;
}

/** The pointer, or null when there is none or it cannot be read. */
async function readActiveOperationPointer(
  paths: SourceStorePaths,
): Promise<ActiveOperationHint | null> {
  const filePath = activeOperationPointerPath(paths);
  if ((await snapshot(filePath)) === "missing") return null;
  try {
    const { operationId, alone } = await readBoundedJson(
      filePath,
      MAX_POINTER_BYTES,
      ActiveOperationPointer,
    );
    if (operationId !== null) assertSafeIdentifier(operationId, "Operation ID");
    return { operationId, alone: alone === true };
  } catch {
    return null;
  }
}

/** Caller holds the `active-operation` lock. */
async function writeActiveOperationPointer(
  paths: SourceStorePaths,
  hint: ActiveOperationHint,
): Promise<void> {
  await atomicWriteJson(
    activeOperationPointerPath(paths),
    { operationId: hint.operationId, ...(hint.alone ? { alone: true } : {}) },
    MAX_POINTER_BYTES,
  );
}

/** A damaged operation can never be continued, since every item update must read it. */
function readOperationIfReadable(
  paths: SourceStorePaths,
  operationId: string,
): Promise<ScientSourceImportOperation | null> {
  return readSourceImportOperationFromPaths(paths, operationId).catch(() => null);
}

/** Answers of a scan for reads, which write nothing, until the operations folder changes. */
const scannedActiveOperations = new Map<
  string,
  { readonly fingerprint: string; readonly operationIds: ReadonlyArray<string> }
>();

async function operationsFolderFingerprint(paths: SourceStorePaths): Promise<string> {
  const stats = await NodeFSP.lstat(paths.operations, { bigint: true }).catch(() => null);
  return stats ? [stats.dev, stats.ino, stats.mtimeNs, stats.ctimeNs].join(":") : "missing";
}

/** The readable running imports, newest first, found by reading every operation. */
async function scanForRunningOperations(
  paths: SourceStorePaths,
  access: "read" | "write",
): Promise<ReadonlyArray<string>> {
  const fingerprint = await operationsFolderFingerprint(paths);
  const known = scannedActiveOperations.get(paths.root);
  if (access === "read" && known?.fingerprint === fingerprint) return known.operationIds;
  const running: ScientSourceImportOperation[] = [];
  if (fingerprint !== "missing") {
    for (const entry of await NodeFSP.readdir(paths.operations, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const operation = await readOperationIfReadable(paths, entry.name.slice(0, -".json".length));
      if (operation?.state === "running") running.push(operation);
    }
  }
  const operationIds = running
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((operation) => operation.operationId);
  if (access === "read") scannedActiveOperations.set(paths.root, { fingerprint, operationIds });
  return operationIds;
}

/** The operation if it is still running; with write access, a settled one is finished first. */
async function runningOperation(
  paths: SourceStorePaths,
  operationId: string,
  access: "read" | "write",
): Promise<ScientSourceImportOperation | null> {
  let operation = await readOperationIfReadable(paths, operationId);
  if (
    access === "write" &&
    operation?.state === "running" &&
    operation.items.every((item) => item.state !== "pending")
  ) {
    operation = await withStoreLock(paths, operationId, async () => {
      const current = await readOperationIfReadable(paths, operationId);
      return current ? finishOperationIfSettled(paths, current) : null;
    });
  }
  return operation?.state === "running" ? operation : null;
}

/**
 * The active import and whether it is the only one running. The pointer answers while the import
 * it names runs, or when it was written alone; otherwise every operation is read once, and with
 * write access the pointer is written again. Caller of "write" holds the `active-operation` lock.
 */
async function findActiveOperationWithHint(
  paths: SourceStorePaths,
  access: "read" | "write",
): Promise<{ readonly operation: ScientSourceImportOperation | null; readonly alone: boolean }> {
  const hint = await readActiveOperationPointer(paths);
  const named = hint?.operationId ? await runningOperation(paths, hint.operationId, access) : null;
  if (named || hint?.alone) return { operation: named, alone: hint?.alone ?? false };
  let operation: ScientSourceImportOperation | null = null;
  let others = 0;
  for (const operationId of await scanForRunningOperations(paths, access)) {
    const running = await runningOperation(paths, operationId, access);
    if (!running) continue;
    if (operation) others += 1;
    else operation = running;
    // A read needs only the newest; whether it runs alone matters to writes.
    if (access === "read") break;
  }
  const alone = access === "write" && others === 0;
  if (access === "write") {
    await writeActiveOperationPointer(paths, {
      operationId: operation?.operationId ?? null,
      alone,
    });
    scannedActiveOperations.delete(paths.root);
  }
  return { operation, alone };
}

/** The running import, if any; with write access, a settled one is finished first. */
async function findActiveOperation(
  paths: SourceStorePaths,
  access: "read" | "write",
): Promise<ScientSourceImportOperation | null> {
  return (await findActiveOperationWithHint(paths, access)).operation;
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
    findActiveOperation(paths, "read"),
    scanTrash(paths),
  ]);
  return {
    projectState: "initialized",
    issues: [],
    records: scan.records,
    activeOperation,
    ...(scan.issues.length > 0 ? { unreadableRecords: scan.issues } : {}),
    ...trashCountsOf(trash),
  };
}

/** The library's records, its running import and its trash count; reading writes nothing. */
const recordRevisions = new WeakMap<LibraryRecordIndex, string>();
const fileDigests = new WeakMap<IndexedFile<RecordFileResult>, string>();

/** What was decoded, not the stamp: a file can change between its stat and its read. */
function fileDigest(file: IndexedFile<RecordFileResult>): string {
  const known = fileDigests.get(file);
  if (known) return known;
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(file.value))
    .digest("base64url");
  fileDigests.set(file, digest);
  return digest;
}

const liveSourceIds = new WeakMap<LibraryRecordIndex, ReadonlySet<string>>();

/** The IDs with a record file, readable or not, as the index last saw them. */
function liveSourceIdsOf(scan: RecordScan): ReadonlySet<string> | undefined {
  if (!("files" in scan)) return undefined;
  const index = scan as LibraryRecordIndex;
  const known = liveSourceIds.get(index);
  if (known) return known;
  const ids = new Set([...index.files.keys()].map((name) => name.slice(0, -".json".length)));
  liveSourceIds.set(index, ids);
  return ids;
}

/**
 * Changes whenever a record file is added, removed or read with other contents. Each entry's
 * digest is kept with the entry, which the index reuses while its file is unchanged.
 */
function recordsRevisionOf(scan: RecordScan): string | undefined {
  if (!("files" in scan)) return undefined;
  const index = scan as LibraryRecordIndex;
  const known = recordRevisions.get(index);
  if (known) return known;
  const hash = NodeCrypto.createHash("sha256");
  for (const [name, file] of index.files) hash.update(`${name}\0${fileDigest(file)}\n`);
  const revision = hash.digest("base64url");
  recordRevisions.set(index, revision);
  return revision;
}

export async function inspectScientLibrarySources(library: ScientLibraryLocation): Promise<{
  readonly records: ReadonlyArray<ScientSourceRecord>;
  readonly activeOperation: ScientSourceImportOperation | null;
  readonly unreadableRecords?: ReadonlyArray<ScientSourceStoreIssue>;
  readonly trashedCount?: number;
  readonly unfinishedDeletions?: number;
  /** See `recordsRevisionOf`; absent when the records were not read through the index. */
  readonly recordsRevision?: string;
}> {
  const paths = await sourceStorePaths(library);
  const [scan, activeOperation] = await Promise.all([
    scanScientSourceRecords(paths),
    findActiveOperation(paths, "read"),
  ]);
  // A library's records come from its index, or there is no records folder and none is live.
  const trash = await scanTrash(paths, liveSourceIdsOf(scan) ?? new Set());
  const recordsRevision = recordsRevisionOf(scan);
  return {
    ...(recordsRevision ? { recordsRevision } : {}),
    records: scan.records,
    activeOperation,
    ...(scan.issues.length > 0 ? { unreadableRecords: scan.issues } : {}),
    ...trashCountsOf(trash),
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
  /** What the place imported from holds that belongs to no item. */
  readonly notBrought?: ReadonlyArray<ScientSourceNotBrought>;
  /** This operation is one part of a run over a scope too large for one. */
  readonly run?: NonNullable<ScientSourceImportOperation["run"]>;
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
      return existing;
    }
    const active = await findActiveOperation(paths, "write");
    if (active) {
      throw new Error(
        paths.owner.kind === "library"
          ? "Another source import is already running in the Library."
          : "Another source import is already running for this project.",
      );
    }
    // Nothing else runs: the pointer named a settled import written alone, or a scan found none.
    await writeActiveOperationPointer(paths, { operationId: input.operationId, alone: true });
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
      ...(input.notBrought && input.notBrought.length > 0
        ? { notBrought: input.notBrought.slice(0, 20) }
        : {}),
      ...(input.run ? { run: input.run } : {}),
    };
    await atomicWriteJson(
      operationPath(paths.operations, input.operationId),
      operation,
      MAX_OPERATION_BYTES,
    );
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
    ...(completed.run ? { runId: completed.run.runId } : {}),
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
  readonly notBrought?: ReadonlyArray<ScientSourceNotBrought>;
  readonly citationKeys?: ReadonlyArray<ScientSourceItemCitationKey>;
  readonly projectKey?: string;
  readonly authorList?: "completed" | "incomplete";
  readonly attachedPdf?: boolean;
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
              ...(input.notBrought && input.notBrought.length > 0
                ? { notBrought: input.notBrought.slice(0, 80) }
                : {}),
              ...(input.citationKeys && input.citationKeys.length > 0
                ? { citationKeys: input.citationKeys.slice(0, 50) }
                : {}),
              ...(input.projectKey ? { projectKey: input.projectKey } : {}),
              ...(input.authorList ? { authorList: input.authorList } : {}),
              ...(input.attachedPdf ? { attachedPdf: true as const } : {}),
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
  // Running again makes it the active import, which only one import may be at a time.
  return withStoreLock(paths, "active-operation", async () => {
    const { operation: active, alone } = await findActiveOperationWithHint(paths, "write");
    if (active && active.operationId !== operationId) {
      throw new Error(
        paths.owner.kind === "library"
          ? "Another source import is already running in the Library."
          : "Another source import is already running for this project.",
      );
    }
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
      await writeActiveOperationPointer(paths, { operationId, alone });
      await atomicWriteJson(
        operationPath(paths.operations, operationId),
        updated,
        MAX_OPERATION_BYTES,
      );
      return updated;
    });
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
    // What a stopped part of a run never reached is still to come: a later part takes it.
    const unreached = operation.items.filter((item) => item.state === "pending").length;
    const cancelled: ScientSourceImportOperation = {
      ...operation,
      state: "cancelled",
      updatedAt: now,
      ...(operation.run
        ? { run: { ...operation.run, remaining: operation.run.remaining + unreached } }
        : {}),
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
      ...(operation.run ? { runId: operation.run.runId } : {}),
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
  /** Every key the file cites a staged entry's work by, by source key, its own key first. */
  citationKeys: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Array(Schema.String.check(Schema.isNonEmpty()))),
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

async function preparePdf(input: {
  readonly paths: SourceStorePaths;
  readonly operationId: string;
  readonly sourcePath: string;
  readonly fileName?: string;
  readonly expectedPdf?: ScientSourcePdfInspection;
  readonly importedAt: string;
  readonly retrieval?: ScientSourceAttachmentRetrieval;
}) {
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
    await NodeFSP.rm(temporaryPath, { force: true });
    const finalStats = await NodeFSP.lstat(finalPath);
    if (!finalStats.isFile() || finalStats.isSymbolicLink() || finalStats.size !== byteLength) {
      throw new Error("An unsafe or damaged copy of this PDF is already stored.");
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
        throw new Error("A damaged copy of this PDF is already stored.");
      }
    }
    const attachment: ScientSourceAttachment = {
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
    return {
      attachment,
      verify: async () => {
        const current = await NodeFSP.lstat(finalPath);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== finalStats.dev ||
          current.ino !== finalStats.ino ||
          current.size !== finalStats.size ||
          current.mtimeMs !== finalStats.mtimeMs ||
          current.ctimeMs !== finalStats.ctimeMs
        ) {
          throw new Error("The staged source PDF changed before it could be attached.");
        }
      },
    };
  } finally {
    await targetHandle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
    await NodeFSP.rmdir(stagingDirectory).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
    });
  }
}

async function stagePdf(input: Parameters<typeof preparePdf>[0]): Promise<ScientSourceAttachment> {
  return (await preparePdf(input)).attachment;
}

export interface ScientSourcePdfAttachmentResult {
  readonly outcome: "attached" | "unchanged" | "stale";
  readonly record: ScientSourceRecord;
  readonly duplicate: ScientSourceDuplicateAssessment;
}

/** `attachScientSourcePdf` for a PDF of `paper`, when the shared rule, under the lock, still takes `paper` for that source. */
export type ScientSourcePaperAttachmentResult =
  | ScientSourcePdfAttachmentResult
  | { readonly outcome: "not-same-work"; readonly duplicate: ScientSourceDuplicateAssessment };

interface AttachPdfInput {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly pdfPath: string;
  readonly fileName?: string;
  readonly actor?: ScientSourceActor;
  readonly retrieval?: ScientSourceAttachmentRetrieval;
  /** The file as it was judged: a PDF that changed since is refused, not attached. */
  readonly expectedPdf?: ScientSourcePdfInspection;
}

export async function attachScientSourcePdf(
  input: AttachPdfInput,
): Promise<ScientSourcePdfAttachmentResult> {
  const paths = await sourceStorePaths(input.root);
  return attachPdfReference(paths, input, () => stageInputPdf(paths, input));
}

/**
 * Attaches a downloaded paper's PDF to the source the shared identity rule took it for, after
 * judging again under the store lock with the Library's current decisions (an Undo, a damaged
 * receipt) and the paper's own identity.
 */
export async function attachScientSourcePaperPdf(
  input: AttachPdfInput & {
    readonly paper: ScientSourceCandidate;
    readonly pdfSha256: string;
  },
): Promise<ScientSourcePaperAttachmentResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", async () => {
    const existing = await listScientSourceRecordsFromPaths(paths);
    const exclusions = await intakeExclusions(paths, existing);
    const duplicate = intakeAssessor(paths, existing, exclusions)(input.paper, input.pdfSha256);
    if (
      duplicate.kind === "new" ||
      duplicate.kind === "possible-metadata-match" ||
      duplicate.matchingSourceIds[0] !== input.sourceId
    ) {
      return { outcome: "not-same-work" as const, duplicate };
    }
    return attachPdfLocked(paths, input, () => stageInputPdf(paths, input));
  });
}

function stageInputPdf(paths: SourceStorePaths, input: AttachPdfInput) {
  return stagePdf({
    paths,
    operationId: `attach_${NodeCrypto.randomUUID()}`,
    sourcePath: input.pdfPath,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    ...(input.expectedPdf ? { expectedPdf: input.expectedPdf } : {}),
    importedAt: new Date().toISOString(),
  });
}

/** Bulk I/O precedes the Library hold; only an unchanged, verified blob can gain a reference. */
async function preparePdfAttachment(input: {
  readonly root: ScientSourceStoreLocation;
  readonly pdfPath: string;
  readonly expectedPdf: ScientSourcePdfInspection;
  readonly fileName: string;
  readonly retrieval?: ScientSourceAttachmentRetrieval;
}) {
  const paths = await sourceStorePaths(input.root);
  const prepared = await preparePdf({
    paths,
    operationId: `package_${NodeCrypto.randomUUID()}`,
    sourcePath: input.pdfPath,
    fileName: input.fileName,
    expectedPdf: input.expectedPdf,
    importedAt: new Date().toISOString(),
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
  });
  return (target: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly actor: ScientSourceActor;
  }) =>
    attachPdfReference(paths, target, async () => {
      await prepared.verify();
      return prepared.attachment;
    });
}

interface PdfReferenceTarget {
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly actor?: ScientSourceActor;
}

async function attachPdfReference(
  paths: SourceStorePaths,
  input: PdfReferenceTarget,
  getAttachment: () => Promise<ScientSourceAttachment>,
): Promise<ScientSourcePdfAttachmentResult> {
  assertSafeIdentifier(input.sourceId, "Source ID");
  return withStoreLock(paths, "source-write", () => attachPdfLocked(paths, input, getAttachment));
}

async function attachPdfLocked(
  paths: SourceStorePaths,
  input: PdfReferenceTarget,
  getAttachment: () => Promise<ScientSourceAttachment>,
): Promise<ScientSourcePdfAttachmentResult> {
  const current = await readSourceRecordFromPaths(paths, input.sourceId);
  const emptyDuplicate: ScientSourceDuplicateAssessment = {
    kind: "new",
    matchingSourceIds: [],
    reason: "No duplicate source was found.",
  };
  if (current.revision !== input.expectedRevision) {
    return { outcome: "stale", record: current, duplicate: emptyDuplicate };
  }
  const attachment = await getAttachment();
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
  readonly hydratedFromProjectSourceId?: string;
  readonly hydratedCitationFields?: ReadonlyArray<string>;
  readonly pdfPath?: string;
  readonly expectedPdf?: ScientSourcePdfInspection;
  readonly allowPossibleMetadataMatch?: boolean;
  readonly actor?: ScientSourceActor;
  readonly intake?: ScientSourceOrigin["intake"];
  readonly verification?: ScientSourceVerification;
  readonly editorialStatus?: ScientSourceEditorialStatus;
  readonly pdfRetrieval?: ScientSourceAttachmentRetrieval;
  /**
   * The ID the candidate already has elsewhere (a package's record): the Library's exclusions of
   * that ID apply too, so a pair kept apart is never joined through the newly derived ID.
   */
  readonly incomingSourceId?: string;
  /** Records the caller found to be another work: never reused. */
  readonly refusedSourceIds?: ReadonlyArray<string>;
}

/** The exclusions an intake assesses with, including those of the candidate's incoming identity. */
function withIncomingIdentity(
  exclusions: ScientLibraryExclusions | undefined,
  input: ImportScientSourceInput,
): ScientSourceIntakeExclusions | undefined {
  const incoming = input.incomingSourceId;
  const refused = new Set(input.refusedSourceIds ?? []);
  if (incoming === undefined && refused.size === 0) return exclusions;
  const asIncoming = (other: string) => incoming !== undefined && incoming !== other;
  return {
    isDistinct: (own, other) =>
      refused.has(other) ||
      (exclusions?.isDistinct(own, other) ?? false) ||
      (asIncoming(other) && (exclusions?.isDistinct(incoming!, other) ?? false)),
    keptApart: (own, other) =>
      exclusions?.keptApart(own, other) ??
      (asIncoming(other) ? (exclusions?.keptApart(incoming!, other) ?? null) : null),
  };
}

async function intakeExclusions(
  paths: SourceStorePaths,
  existing: ReadonlyArray<ScientSourceRecord>,
): Promise<ScientLibraryExclusions | undefined> {
  if (paths.owner.kind !== "library") return undefined;
  return readScientLibraryExclusions(
    paths.root,
    new Set(existing.map((record) => record.sourceId)),
  );
}

/**
 * The ID a new record of this import takes: the one its source key derives, unless that ID is a
 * merged-away source or one a merge alias forwards (a live record there is always reused), or
 * a trash entry there cannot be read or is being deleted. `trashed` is the paper a person moved
 * to the Trash under that ID, which the new record takes the place of.
 */
async function newRecordId(
  paths: SourceStorePaths,
  input: ImportScientSourceInput,
  existing: ReadonlyArray<ScientSourceRecord>,
  exclusions: ScientLibraryExclusions | undefined,
): Promise<{ readonly sourceId: string; readonly trashed?: ScientSourceTrashEntry }> {
  const derived = scientSourceIdFor(storeOwnerId(paths), input.candidate.sourceKey);
  const alternate = {
    sourceId: scientSourceIdFor(
      storeOwnerId(paths),
      `${input.candidate.sourceKey}\0${input.operationId}`,
    ),
  };
  if (existing.some((record) => record.sourceId === derived) || exclusions?.forwarded(derived)) {
    return alternate;
  }
  if ((await snapshot(trashEntryPath(paths, derived))) === "missing") return { sourceId: derived };
  const trashed = await readTrashEntry(paths, derived).catch(() => null);
  return trashed && !trashed.mergedInto && !(await deletionStartedOn(paths, trashed))
    ? { sourceId: derived, trashed }
    : alternate;
}

/** The Library's merge decisions intake respects; none for a project store. */
export async function readScientSourceIntakeExclusions(
  root: ScientSourceStoreLocation,
  existing: ReadonlyArray<ScientSourceRecord>,
): Promise<ScientLibraryExclusions | undefined> {
  return intakeExclusions(await sourceStorePaths(root), existing);
}

/** The shared identity rule bound to a store's records and Library decisions. */
function intakeAssessor(
  paths: SourceStorePaths,
  existing: ReadonlyArray<ScientSourceRecord>,
  exclusions: ScientSourceIntakeExclusions | undefined,
  operationId?: string,
) {
  const owner = storeOwnerId(paths);
  return (candidate: ScientSourceCandidate, pdfSha256?: string) => {
    const sourceId = scientSourceIdFor(owner, candidate.sourceKey);
    const alternate =
      operationId && scientSourceIdFor(owner, `${candidate.sourceKey}\0${operationId}`);
    // Only a record this operation wrote proves a retry; the derived key alone does not.
    const accepted = alternate
      ? existing.find(
          (record) =>
            record.sourceId === alternate ||
            (record.sourceId === sourceId && record.origin?.operationId === operationId),
        )
      : undefined;
    return assessSourceDuplicate({
      candidate,
      existing,
      sourceId,
      ...(accepted ? { acceptedSourceId: accepted.sourceId } : {}),
      ...(pdfSha256 ? { pdfSha256 } : {}),
      ...(exclusions ? { exclusions } : {}),
    });
  };
}

/**
 * The shared identity rule against a store as it is now, outside any import's lock: for checks
 * before an import (preflight, whether a registry needs asking). The final import checks again.
 */
export async function readScientSourceIntakeAssessor(root: ScientSourceStoreLocation): Promise<{
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly assess: (
    candidate: ScientSourceCandidate,
    pdfSha256?: string,
  ) => ScientSourceDuplicateAssessment;
}> {
  const paths = await sourceStorePaths(root);
  const existing = await listScientSourceRecordsFromPaths(paths);
  return {
    existing,
    assess: intakeAssessor(paths, existing, await intakeExclusions(paths, existing)),
  };
}

/** `readScientSourceIntakeAssessor` for one candidate. */
export async function assessScientSourceIntake(input: {
  readonly root: ScientSourceStoreLocation;
  readonly candidate: ScientSourceCandidate;
  readonly pdfSha256?: string;
}): Promise<ScientSourceDuplicateAssessment> {
  return (await readScientSourceIntakeAssessor(input.root)).assess(
    input.candidate,
    input.pdfSha256,
  );
}

function importScientSourceWithRecordLookup(
  input: ImportScientSourceInput,
  lookup: "complete" | "operation-snapshot",
  attachToSameWork?: false,
): Promise<ImportedSourceResult>;
function importScientSourceWithRecordLookup(
  input: ImportScientSourceInput,
  lookup: "operation-snapshot",
  attachToSameWork: true,
): Promise<ImportedOrAttachedSourceResult>;
async function importScientSourceWithRecordLookup(
  input: ImportScientSourceInput,
  lookup: "complete" | "operation-snapshot",
  attachToSameWork = false,
): Promise<ImportedOrAttachedSourceResult> {
  assertSafeIdentifier(input.operationId, "Operation ID");
  assertStorableSourceType(input.candidate.type);
  const paths = await sourceStorePaths(input.root);
  return withStoreLock(paths, "source-write", async () => {
    const existing =
      lookup === "operation-snapshot"
        ? await operationRecordSnapshot(paths, input.operationId)
        : await listScientSourceRecordsFromPaths(paths);
    const exclusions = await intakeExclusions(paths, existing);
    const assessedExclusions = withIncomingIdentity(exclusions, input);
    const assess = (records: ReadonlyArray<ScientSourceRecord>, pdfSha256?: string) =>
      intakeAssessor(
        paths,
        records,
        assessedExclusions,
        input.operationId,
      )(input.candidate, pdfSha256);
    const importedAt = new Date().toISOString();
    const preliminaryDuplicate = assess(existing, input.expectedPdf?.sha256);
    const sameWork = attachToSameWork
      ? sameWorkWithoutPdf(preliminaryDuplicate, existing, input.expectedPdf?.sha256)
      : null;
    if (sameWork && input.pdfPath && input.expectedPdf) {
      const { pdfPath, expectedPdf } = input;
      const attached = await attachPdfLocked(
        paths,
        {
          sourceId: sameWork.sourceId,
          expectedRevision: sameWork.revision,
          ...(input.actor ? { actor: input.actor } : {}),
        },
        () =>
          stagePdf({
            paths,
            operationId: input.operationId,
            sourcePath: pdfPath,
            ...(input.candidate.pdfFileName ? { fileName: input.candidate.pdfFileName } : {}),
            expectedPdf,
            importedAt,
          }),
      );
      if (attached.outcome === "stale") {
        // The lock is held and the ledger checked, so this is damage; the PDF stays staged.
        throw new Error("The source changed while its PDF was being added. Try again.");
      }
      if (attached.outcome === "attached") {
        return { outcome: "attached", record: attached.record, duplicate: preliminaryDuplicate };
      }
    }
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
    const duplicate = assess(existing, attachment?.sha256);
    if (duplicateBlocksImport(duplicate, input.allowPossibleMetadataMatch ?? false)) {
      return { outcome: "duplicate", record: null, duplicate };
    }
    const { sourceId, trashed } = await newRecordId(paths, input, existing, exclusions);
    const citationKey = assignCitationKey({
      // Documents may already cite the trashed paper by its key.
      preferred: trashed?.record.citationKey ?? input.candidate.citationKey,
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
    // An entry that does not fit is left out whole, never cut; the importer says so.
    const { more } = normalizeScientSourceMore(input.candidate.more);
    const record: ScientSourceRecord = {
      formatVersion: storeFormatVersion(paths),
      sourceId,
      ...projectField(paths),
      ...(paths.owner.kind === "library" && input.hydratedFromProjectSourceId
        ? { hydratedFromProjectSourceId: input.hydratedFromProjectSourceId }
        : {}),
      ...(paths.owner.kind === "library" && input.hydratedCitationFields !== undefined
        ? { hydratedCitationFields: input.hydratedCitationFields }
        : {}),
      revision,
      citationKey,
      type: input.candidate.type,
      customType: input.candidate.customType ?? null,
      title: input.candidate.title,
      creators: input.candidate.creators,
      ...(input.candidate.incompleteCreatorRoles?.length
        ? { incompleteCreatorRoles: input.candidate.incompleteCreatorRoles }
        : {}),
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
      ...(more ? { more } : {}),
      tags: input.candidate.tags,
      ...(input.candidate.note
        ? { note: normalizeScientSourceNote(input.candidate.note) }
        : trashed?.record.note
          ? { note: trashed.record.note }
          : {}),
      externalReferences: input.candidate.externalReferences,
      // What the person kept on the trashed paper stays: its PDFs, and below its reading state.
      attachments: [
        ...(trashed?.record.attachments ?? []).filter((kept) => kept.sha256 !== attachment?.sha256),
        ...(attachment ? [attachment] : []),
      ],
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
      ...(trashed ? scientSourceReadingState(trashed.record) : {}),
    };
    const recordPath = sourceRecordPath(paths, sourceId);
    if (!(await atomicCreateJson(recordPath, record, MAX_RECORD_BYTES))) {
      const concurrentRecords = await listScientSourceRecordsFromPaths(paths);
      if (lookup === "operation-snapshot") {
        await replaceOperationRecordSnapshot(paths, input.operationId, concurrentRecords);
      }
      const concurrentDuplicate = assess(concurrentRecords, attachment?.sha256);
      if (concurrentDuplicate.kind === "new") {
        throw new Error("A conflicting source record was created concurrently.");
      }
      return { outcome: "duplicate", record: null, duplicate: concurrentDuplicate };
    }
    // The trashed paper's own record stays in its history.
    if (trashed) await NodeFSP.rm(trashEntryPath(paths, sourceId), { force: true });
    if (lookup === "operation-snapshot") {
      const next = [record, ...existing].toSorted((left, right) =>
        right.importedAt.localeCompare(left.importedAt),
      );
      carryScientSourceIntakeIndex(existing, next);
      await replaceOperationRecordSnapshot(paths, input.operationId, next);
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

/**
 * `importScientSourceOperationItem` for a PDF: when the work is certainly here already and that
 * source lacks this very file, the PDF is added to it, judged and written under the same lock.
 */
export async function importOrAttachScientSourceOperationItem(
  input: ImportScientSourceInput & {
    readonly pdfPath: string;
    readonly expectedPdf: ScientSourcePdfInspection;
  },
): Promise<ImportedOrAttachedSourceResult> {
  return importScientSourceWithRecordLookup(input, "operation-snapshot", true);
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

/** A base whose source change was written first: it is the base once that change landed. */
function zoteroSyncPendingPath(paths: SourceStorePaths, sourceId: string): string {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.zotero, "pending", `${sourceId}.json`);
}

/** The pending copy holds the base it replaces and the one it stands for. */
const MAX_PENDING_SYNC_BYTES = MAX_RECORD_BYTES * 2;

async function savedZoteroSync(
  paths: SourceStorePaths,
  sourceId: string,
): Promise<ScientSourceZoteroSyncType | null> {
  const filePath = zoteroSyncPath(paths, sourceId);
  if ((await snapshot(filePath)) === "missing") return null;
  // A damaged sync file only loses the merge base; refresh then treats every difference as new.
  return readBoundedJson(filePath, MAX_RECORD_BYTES, ScientSourceZoteroSync).catch(() => null);
}

const ZoteroSyncPending = Schema.Struct({
  revision: Schema.Number,
  updatedAt: Schema.String,
  previous: Schema.NullOr(ScientSourceZoteroSync),
  base: ScientSourceZoteroSync,
});

async function revisionLanded(
  paths: SourceStorePaths,
  sourceId: string,
  written: { readonly revision: number; readonly updatedAt: string },
): Promise<boolean> {
  const at = async (filePath: string) => {
    if ((await snapshot(filePath)) === "missing") return false;
    const record = await readBoundedSourceRecord(filePath).catch(() => null);
    return record?.revision === written.revision && record.updatedAt === written.updatedAt;
  };
  return (
    (await at(sourceRecordPath(paths, sourceId))) ||
    (await at(sourceHistoryPath(paths, sourceId, written.revision)))
  );
}

/** The Zotero values a source was last synced from, or null before its first sync. */
export async function readScientSourceZoteroSync(
  root: ScientSourceStoreLocation,
  sourceId: string,
): Promise<ScientSourceZoteroSyncType | null> {
  const paths = await sourceStorePaths(root);
  const saved = await savedZoteroSync(paths, sourceId);
  const pendingPath = zoteroSyncPendingPath(paths, sourceId);
  if ((await snapshot(pendingPath)) === "missing") return saved;
  const pending = await readBoundedJson(
    pendingPath,
    MAX_PENDING_SYNC_BYTES,
    ZoteroSyncPending,
  ).catch(() => null);
  // Its source change landed and no base was saved since: the write stopped between the two.
  return pending &&
    JSON.stringify(pending.previous) === JSON.stringify(saved) &&
    (await revisionLanded(paths, sourceId, pending))
    ? pending.base
    : saved;
}

function fitZoteroSyncToBudget(
  state: ScientSourceZoteroSyncType,
  maxBytes: number,
): {
  readonly state: ScientSourceZoteroSyncType;
  readonly omittedOriginalNoteHtmlCount: number;
} {
  const byteLength = (value: ScientSourceZoteroSyncType) =>
    Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (!state.notes || byteLength(state) <= maxBytes) {
    return { state, omittedOriginalNoteHtmlCount: 0 };
  }
  // Drop optional retained HTML from the end until the serialized UTF-8 sync file fits the
  // record byte budget, always preserving note digests and both text baselines.
  const notes = state.notes.map((entry) => ({ ...entry }));
  let omittedOriginalNoteHtmlCount = 0;
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const entry = notes[index];
    if (!entry || entry.html === undefined) continue;
    notes[index] = { itemKey: entry.itemKey, sha256: entry.sha256 };
    omittedOriginalNoteHtmlCount += 1;
    const candidate: ScientSourceZoteroSyncType = { ...state, notes };
    if (byteLength(candidate) <= maxBytes) {
      return { state: candidate, omittedOriginalNoteHtmlCount };
    }
  }
  return { state: { ...state, notes }, omittedOriginalNoteHtmlCount };
}

interface ZoteroSyncSaved {
  readonly omittedOriginalNoteHtmlCount: number;
  /** What was saved, or null when nothing was: the source is gone or its base moved on. */
  readonly saved: ScientSourceZoteroSyncType | null;
}

async function zoteroSyncStillIs(
  root: ScientSourceStoreLocation,
  sourceId: string,
  replacing: ScientSourceZoteroSyncType | null,
): Promise<boolean> {
  return (
    JSON.stringify(await readScientSourceZoteroSync(root, sourceId)) === JSON.stringify(replacing)
  );
}

/** The base as it is saved: with the import's provenance kept, and fitted to its budget. */
async function preparedZoteroSync(
  paths: SourceStorePaths,
  state: ScientSourceZoteroSyncType,
  options?: { readonly initialImportOperationId?: string },
): Promise<{
  readonly state: ScientSourceZoteroSyncType;
  readonly omittedOriginalNoteHtmlCount: number;
}> {
  let prepared: ScientSourceZoteroSyncType;
  if (options?.initialImportOperationId !== undefined) {
    prepared = {
      ...state,
      importOperationId: options.initialImportOperationId,
      importOmittedOriginalNoteHtml:
        state.notes?.some((entry) => entry.html === undefined) ?? false,
    };
  } else if (
    state.importOperationId === undefined ||
    state.importOmittedOriginalNoteHtml === undefined
  ) {
    // A later sync write keeps the initial import's provenance and omission decision.
    const existing = await readScientSourceZoteroSync(paths.location, state.sourceId);
    const importOperationId = state.importOperationId ?? existing?.importOperationId;
    prepared = {
      ...state,
      ...(importOperationId !== undefined ? { importOperationId } : {}),
      ...(state.importOmittedOriginalNoteHtml === undefined &&
      existing?.importOmittedOriginalNoteHtml !== undefined &&
      existing.importOperationId !== undefined &&
      existing.importOperationId === importOperationId
        ? { importOmittedOriginalNoteHtml: existing.importOmittedOriginalNoteHtml }
        : {}),
    };
  } else {
    prepared = state;
  }
  const bounded = fitZoteroSyncToBudget(prepared, MAX_RECORD_BYTES);
  // Flipping false -> true shrinks JSON by 1 byte, so the bounded payload stays within MAX_RECORD_BYTES.
  const finalState: ScientSourceZoteroSyncType =
    options?.initialImportOperationId !== undefined && bounded.omittedOriginalNoteHtmlCount > 0
      ? { ...bounded.state, importOmittedOriginalNoteHtml: true }
      : bounded.state;
  return {
    state: finalState,
    omittedOriginalNoteHtmlCount: bounded.omittedOriginalNoteHtmlCount,
  };
}

/** Caller holds the source-write lock. */
async function savePreparedZoteroSync(
  paths: SourceStorePaths,
  root: ScientSourceStoreLocation,
  prepared: Awaited<ReturnType<typeof preparedZoteroSync>>,
): Promise<ZoteroSyncSaved> {
  const { sourceId } = prepared.state;
  await atomicWriteJson(zoteroSyncPath(paths, sourceId), prepared.state, MAX_RECORD_BYTES);
  await NodeFSP.rm(zoteroSyncPendingPath(paths, sourceId), { force: true });
  return {
    omittedOriginalNoteHtmlCount: prepared.omittedOriginalNoteHtmlCount,
    // As a later read decodes it, so it can be the base a next write replaces.
    saved: await readScientSourceZoteroSync(root, sourceId),
  };
}

/** Caller holds the source-write lock. */
async function saveZoteroSyncLocked(
  paths: SourceStorePaths,
  root: ScientSourceStoreLocation,
  state: ScientSourceZoteroSyncType,
  options?: { readonly initialImportOperationId?: string },
): Promise<ZoteroSyncSaved> {
  const gone = async (path: string) => (await snapshot(path)) === "missing";
  if (
    (await gone(sourceRecordPath(paths, state.sourceId))) &&
    (await gone(trashEntryPath(paths, state.sourceId)))
  ) {
    return { omittedOriginalNoteHtmlCount: 0, saved: null };
  }
  return savePreparedZoteroSync(paths, root, await preparedZoteroSync(paths, state, options));
}

export async function writeScientSourceZoteroSync(
  root: ScientSourceStoreLocation,
  state: ScientSourceZoteroSyncType,
  options?: {
    readonly initialImportOperationId?: string;
    /** The base this one was planned from: written only while it is still the saved base. */
    readonly replacing?: ScientSourceZoteroSyncType | null;
  },
): Promise<ZoteroSyncSaved> {
  const paths = await sourceStorePaths(root);
  // Under deletion's lock: a sync finishing after Delete for good must not bring its base back.
  return withStoreLock(paths, "source-write", async () => {
    if (
      options?.replacing !== undefined &&
      !(await zoteroSyncStillIs(root, state.sourceId, options.replacing))
    ) {
      return { omittedOriginalNoteHtmlCount: 0, saved: null };
    }
    return saveZoteroSyncLocked(paths, root, state, options);
  });
}

/** A Zotero link whose version is older than the one the source has for the same item. */
function olderZoteroLink(
  current: ReadonlyArray<ScientSourceExternalReference>,
  next: ReadonlyArray<ScientSourceExternalReference>,
): boolean {
  return next.some((entry) =>
    current.some(
      (known) =>
        entry.system === "zotero" &&
        known.system === "zotero" &&
        known.libraryId === entry.libraryId &&
        known.itemKey === entry.itemKey &&
        (known.itemVersion ?? 0) > (entry.itemVersion ?? 0),
    ),
  );
}

/**
 * A Zotero sync's change to a source, the PDFs it brings and the base it was planned from, in
 * one write: all of it, or nothing once the saved base is no longer `replacing`, a Zotero
 * version would go back, or the change is refused. The base is saved after the source, through
 * a pending copy that stands for it if that last write fails.
 */
export async function commitScientSourceZoteroSync(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly replacing: ScientSourceZoteroSyncType | null;
  /** Omitted: the record change alone, with no base to keep in step. */
  readonly base?: ScientSourceZoteroSyncType;
  readonly change?: {
    /** What the plan read; a change of the note alone is checked against `note` when given. */
    readonly expected: { readonly revision: number; readonly note?: string | null };
    readonly details?: Omit<
      MetadataUpdate,
      "sourceId" | "expectedRevision" | "note" | "externalReferences" | "attachments" | "actor"
    >;
    readonly note?: string | null;
  };
  /** The source's links as the sync leaves them, from the links it has now. */
  readonly externalReferences?: (
    current: ReadonlyArray<ScientSourceExternalReference>,
  ) => ReadonlyArray<ScientSourceExternalReference>;
  /** PDFs to attach, as they were inspected; one already attached is passed by. */
  readonly pdfs?: ReadonlyArray<{
    readonly path: string;
    readonly fileName?: string;
    readonly expected: ScientSourcePdfInspection;
  }>;
  readonly actor?: ScientSourceActor;
}): Promise<
  ZoteroSyncSaved & {
    readonly outcome: "updated" | "unchanged" | "stale" | "duplicate";
    readonly record: ScientSourceRecord;
    /** The details (and with them the note and links) were written. */
    readonly detailsUpdated: boolean;
    readonly addedPdfCount: number;
  }
> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  // Bulk I/O precedes the lock; only a verified, unchanged copy is attached under it.
  const importedAt = new Date().toISOString();
  const prepared: Array<Awaited<ReturnType<typeof preparePdf>>> = [];
  for (const pdf of input.pdfs ?? []) {
    prepared.push(
      await preparePdf({
        paths,
        operationId: `zotero_${NodeCrypto.randomUUID()}`,
        sourcePath: pdf.path,
        ...(pdf.fileName ? { fileName: pdf.fileName } : {}),
        expectedPdf: pdf.expected,
        importedAt,
      }),
    );
  }
  return withStoreLock(paths, "source-write", async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    const refused = (outcome: "stale" | "duplicate", record = current) => ({
      outcome,
      record,
      detailsUpdated: false,
      addedPdfCount: 0,
      omittedOriginalNoteHtmlCount: 0,
      saved: null,
    });
    if (input.base) {
      const saved = await readScientSourceZoteroSync(input.root, input.sourceId);
      if (JSON.stringify(saved) !== JSON.stringify(input.replacing)) return refused("stale");
      if (
        saved?.itemKey === input.base.itemKey &&
        saved.libraryId === input.base.libraryId &&
        saved.itemVersion > input.base.itemVersion
      ) {
        return refused("stale");
      }
    }
    const { change } = input;
    const references = input.externalReferences?.(current.externalReferences) ?? [
      ...current.externalReferences,
    ];
    if (olderZoteroLink(current.externalReferences, references)) return refused("stale");
    const attachments: ScientSourceAttachment[] = [];
    for (const pdf of prepared) {
      await pdf.verify();
      const known = [...current.attachments, ...attachments];
      if (!known.some((entry) => entry.sha256 === pdf.attachment.sha256)) {
        attachments.push(pdf.attachment);
      }
    }
    const base = input.base ? await preparedZoteroSync(paths, input.base) : null;
    if (base) {
      // A pending copy left by an earlier write is settled first: saved, if it stands.
      const standing = await readScientSourceZoteroSync(input.root, input.sourceId);
      if (
        JSON.stringify(standing) !== JSON.stringify(await savedZoteroSync(paths, input.sourceId))
      ) {
        await atomicWriteJson(zoteroSyncPath(paths, input.sourceId), standing, MAX_RECORD_BYTES);
      }
      await NodeFSP.rm(zoteroSyncPendingPath(paths, input.sourceId), { force: true });
    }
    // The pending base goes first, so a failure after the source is written leaves it standing.
    const persist = async (from: ScientSourceRecord, next: ScientSourceRecord) => {
      if (base) {
        await atomicWriteJson(
          zoteroSyncPendingPath(paths, input.sourceId),
          {
            revision: next.revision,
            updatedAt: next.updatedAt,
            previous: input.replacing,
            base: base.state,
          },
          MAX_PENDING_SYNC_BYTES,
        );
      }
      await persistSourceRevision(paths, from, next);
    };
    let record = current;
    let outcome: "updated" | "unchanged" = "unchanged";
    let detailsUpdated = false;
    if (change?.details) {
      let others: Promise<ReadonlyArray<ScientSourceRecord>> | undefined;
      const lookupOthers = (sourceId: string) =>
        (others ??= listScientSourceRecordsFromPaths(paths).then((records) =>
          records.filter((entry) => entry.sourceId !== sourceId),
        ));
      const result = await applyMetadataUpdate(
        paths,
        {
          ...change.details,
          sourceId: input.sourceId,
          expectedRevision: change.expected.revision,
          ...(change.note !== undefined ? { note: change.note } : {}),
          externalReferences: references,
          attachments,
          ...(input.actor ? { actor: input.actor } : {}),
        },
        { duplicates: (_, id) => lookupOthers(id), others: lookupOthers },
        persist,
      );
      if (result.outcome === "stale" || result.outcome === "duplicate") {
        return refused(result.outcome, result.record);
      }
      if (result.outcome === "updated") {
        record = result.record;
        outcome = "updated";
        detailsUpdated = true;
      }
    }
    if (!detailsUpdated) {
      const note =
        change?.note !== undefined
          ? normalizeScientSourceNote(change.note)
          : (current.note ?? null);
      const noteChanges = note !== normalizeScientSourceNote(current.note ?? null);
      const othersChange =
        attachments.length > 0 ||
        JSON.stringify(references) !== JSON.stringify(current.externalReferences);
      const { expected } = change ?? {};
      if (
        expected &&
        (noteChanges || othersChange) &&
        (noteChanges && !othersChange && expected.note !== undefined
          ? normalizeScientSourceNote(current.note ?? null) !==
            normalizeScientSourceNote(expected.note)
          : current.revision !== expected.revision)
      ) {
        return refused("stale");
      }
      if (noteChanges || othersChange) {
        record = {
          ...current,
          note,
          externalReferences: [...references],
          attachments: [...current.attachments, ...attachments],
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: input.actor ?? "user",
        };
        await persist(current, record);
        outcome = "updated";
      }
    }
    const saved = base
      ? await savePreparedZoteroSync(paths, input.root, base)
      : { omittedOriginalNoteHtmlCount: 0, saved: null };
    return {
      outcome,
      record,
      detailsUpdated,
      addedPdfCount: outcome === "updated" ? attachments.length : 0,
      ...saved,
    };
  });
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
  preparePdfAttachment,
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
