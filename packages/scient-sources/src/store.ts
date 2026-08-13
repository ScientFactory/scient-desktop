// @effect-diagnostics nodeBuiltinImport:off -- The store is Scient's explicit project filesystem boundary.
// @effect-diagnostics globalDate:off -- Portable records and receipts use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  inspectScientProject,
  readScientProjectIdentity,
  type ScientProjectIdentity,
} from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { assessSourceDuplicate, assessSourceMetadataDuplicate } from "./duplicates.ts";
import { abstractDocumentFromSections, normalizeScientSourceAbstractDocument } from "./abstract.ts";
import {
  applyEditableMetadata,
  editableMetadataEquals,
  editableMetadataFromRecord,
  normalizeScientSourceEditableMetadata,
  validateScientSourceEditableMetadata,
} from "./editable.ts";
import {
  ScientSourceImportOperation,
  ScientSourceImportReceipt,
  ScientSourceRecord,
  ScientSourceStagedMaterial,
  SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  type ScientSourceAttachment,
  type ScientSourceCandidate,
  type ScientSourceDuplicateAssessment,
  type ScientSourceDuplicateKind,
  type ScientSourceEditableMetadata,
  type ScientSourceMetadataUpdateResult,
  type ScientSourceNoteUpdateResult,
  type ScientSourceStagedMaterial as ScientSourceStagedMaterialType,
  type ScientSourceRemovalResult,
  type ScientSourcesOverview,
} from "./model.ts";

export const SCIENT_SOURCES_DIRECTORY = ".scient/sources";
export const SCIENT_SOURCE_RECORDS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/records`;
export const SCIENT_SOURCE_FILES_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/files/sha256`;
export const SCIENT_SOURCE_HISTORY_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/history`;
export const SCIENT_SOURCE_OPERATIONS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/operations`;
export const SCIENT_SOURCE_RECEIPTS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/receipts`;
export const SCIENT_SOURCE_STAGING_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/staging`;

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_STAGED_MATERIAL_BYTES = 2 * 1024 * 1024;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const operationLocks = new Map<string, Promise<unknown>>();
const activeOperationIds = new Map<string, string>();
const operationRecordSnapshots = new Map<
  string,
  {
    readonly fingerprint: string;
    readonly records: ReadonlyArray<ScientSourceRecord>;
  }
>();
const decodeScientSourceRecordV1 = Schema.decodeUnknownSync(ScientSourceRecord);
const decodeScientSourceStagedMaterial = Schema.decodeUnknownSync(ScientSourceStagedMaterial);
const PersistedScientSourceImportOperation = Schema.Struct({
  ...ScientSourceImportOperation.fields,
  // Operations written before local-file imports existed did not record an adapter.
  adapter: Schema.optionalKey(ScientSourceImportOperation.fields.adapter),
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is not a safe portable identifier.`);
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function boundedJson(value: unknown, maximumBytes: number, label: string): string {
  const serialized = formatJson(value);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds the safe size limit.`);
  }
  return serialized;
}

async function snapshot(filePath: string): Promise<"missing" | "file" | "directory" | "unsafe"> {
  try {
    const value = await NodeFSP.lstat(filePath);
    if (value.isSymbolicLink()) return "unsafe";
    if (value.isFile()) return "file";
    if (value.isDirectory()) return "directory";
    return "unsafe";
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function readBoundedJson<S extends Schema.ConstraintDecoder<unknown>>(
  filePath: string,
  maximumBytes: number,
  schema: S,
): Promise<S["Type"]> {
  const stats = await NodeFSP.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
  }
  if (stats.size > maximumBytes) {
    throw new Error(`${NodePath.basename(filePath)} exceeds the safe size limit.`);
  }
  const value: unknown = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
  return Schema.decodeUnknownSync(schema)(value);
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
    default:
      throw new Error(`Source record format version ${String(version)} is not supported.`);
  }
}

async function readBoundedSourceRecord(filePath: string): Promise<ScientSourceRecord> {
  const value = await readBoundedJson(filePath, MAX_RECORD_BYTES, Schema.Unknown);
  return decodePersistedScientSourceRecord(value);
}

async function ensureDirectory(filePath: string): Promise<void> {
  await NodeFSP.mkdir(filePath, { recursive: true });
  if ((await snapshot(filePath)) !== "directory") {
    throw new Error(`${NodePath.basename(filePath)} is not a safe directory.`);
  }
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
  maximumBytes: number,
): Promise<void> {
  const serialized = boundedJson(value, maximumBytes, NodePath.basename(filePath));
  await ensureDirectory(NodePath.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await NodeFSP.rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}

async function atomicCreateJson(
  filePath: string,
  value: unknown,
  maximumBytes: number,
): Promise<boolean> {
  const serialized = boundedJson(value, maximumBytes, NodePath.basename(filePath));
  await ensureDirectory(NodePath.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await NodeFSP.link(temporaryPath, filePath);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
      try {
        await NodeFSP.copyFile(temporaryPath, filePath, NodeFSP.constants.COPYFILE_EXCL);
        return true;
      } catch (copyError) {
        if (isNodeError(copyError, "EEXIST")) return false;
        throw copyError;
      }
    }
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
  }
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

export async function canonicalizeScientSourceRoot(root: string): Promise<string> {
  return NodeFSP.realpath(root);
}

async function sourceStorePaths(root: string): Promise<{
  readonly root: string;
  readonly identity: ScientProjectIdentity;
  readonly records: string;
  readonly files: string;
  readonly history: string;
  readonly operations: string;
  readonly receipts: string;
  readonly staging: string;
}> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const identity = await readScientProjectIdentity(resolvedRoot);
  return {
    root: resolvedRoot,
    identity,
    records: NodePath.join(resolvedRoot, SCIENT_SOURCE_RECORDS_DIRECTORY),
    files: NodePath.join(resolvedRoot, SCIENT_SOURCE_FILES_DIRECTORY),
    history: NodePath.join(resolvedRoot, SCIENT_SOURCE_HISTORY_DIRECTORY),
    operations: NodePath.join(resolvedRoot, SCIENT_SOURCE_OPERATIONS_DIRECTORY),
    receipts: NodePath.join(resolvedRoot, SCIENT_SOURCE_RECEIPTS_DIRECTORY),
    staging: NodePath.join(resolvedRoot, SCIENT_SOURCE_STAGING_DIRECTORY),
  };
}

type SourceStorePaths = Awaited<ReturnType<typeof sourceStorePaths>>;

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

function sourceRecordPath(paths: Awaited<ReturnType<typeof sourceStorePaths>>, sourceId: string) {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.records, `${sourceId}.json`);
}

async function readSourceRecordFromPaths(
  paths: Awaited<ReturnType<typeof sourceStorePaths>>,
  sourceId: string,
): Promise<ScientSourceRecord> {
  const record = await readBoundedSourceRecord(sourceRecordPath(paths, sourceId));
  if (record.projectId !== paths.identity.projectId) {
    throw new Error("The source record belongs to another Scient project.");
  }
  if (record.sourceId !== sourceId) throw new Error("The source record identity is inconsistent.");
  return record;
}

/** Reads one source without scanning or decoding the rest of the project ledger. */
export async function readScientSourceRecord(
  root: string,
  sourceId: string,
): Promise<ScientSourceRecord | null> {
  const paths = await sourceStorePaths(root);
  const filePath = sourceRecordPath(paths, sourceId);
  if ((await snapshot(filePath)) === "missing") return null;
  return readSourceRecordFromPaths(paths, sourceId);
}

function sourceHistoryPath(
  paths: Awaited<ReturnType<typeof sourceStorePaths>>,
  sourceId: string,
  revision: number,
) {
  assertSafeIdentifier(sourceId, "Source ID");
  return NodePath.join(paths.history, sourceId, `${revision}.json`);
}

async function latestSourceHistoryRevision(
  paths: Awaited<ReturnType<typeof sourceStorePaths>>,
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
      record.projectId !== paths.identity.projectId ||
      record.sourceId !== sourceId ||
      record.revision !== revision
    ) {
      throw new Error(`Source history ${entry.name} has inconsistent identity.`);
    }
    latestRevision = Math.max(latestRevision, revision);
  }
  return latestRevision;
}

export async function updateScientSourceMetadata(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly metadata: ScientSourceEditableMetadata;
  readonly allowPossibleMetadataMatch?: boolean;
}): Promise<ScientSourceMetadataUpdateResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  const normalized = normalizeScientSourceEditableMetadata(input.metadata);
  const validationIssues = validateScientSourceEditableMetadata(normalized);
  if (validationIssues.length > 0) {
    throw new Error(validationIssues.map((issue) => issue.message).join(" "));
  }

  return withOperationLock(`${paths.root}:source-write`, async () => {
    const current = await readSourceRecordFromPaths(paths, input.sourceId);
    const currentMetadata = normalizeScientSourceEditableMetadata(
      editableMetadataFromRecord(current),
    );
    const existing = (await listScientSourceRecords(paths.root)).filter(
      (record) => record.sourceId !== current.sourceId,
    );
    const duplicate = assessSourceMetadataDuplicate({ source: normalized, existing });

    // A client that lost the successful response may retry with the old revision.
    if (editableMetadataEquals(currentMetadata, normalized)) {
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

    const next = applyEditableMetadata({
      record: current,
      metadata: normalized,
      updatedAt: new Date().toISOString(),
    });
    const preserved = await atomicCreateJson(
      sourceHistoryPath(paths, current.sourceId, current.revision),
      current,
      MAX_RECORD_BYTES,
    );
    if (!preserved) {
      const history = await readBoundedSourceRecord(
        sourceHistoryPath(paths, current.sourceId, current.revision),
      );
      if (JSON.stringify(history) !== JSON.stringify(current)) {
        throw new Error("The source revision history conflicts with the current record.");
      }
    }
    await atomicWriteJson(sourceRecordPath(paths, current.sourceId), next, MAX_RECORD_BYTES);
    return { outcome: "updated", record: next, duplicate, validationIssues };
  });
}

function normalizeScientSourceNote(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.trim() ? normalized : null;
}

export async function updateScientSourceNote(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly note: string | null;
}): Promise<ScientSourceNoteUpdateResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");
  const note = normalizeScientSourceNote(input.note);

  return withOperationLock(`${paths.root}:source-write`, async () => {
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
    };
    const preserved = await atomicCreateJson(
      sourceHistoryPath(paths, current.sourceId, current.revision),
      current,
      MAX_RECORD_BYTES,
    );
    if (!preserved) {
      const history = await readBoundedSourceRecord(
        sourceHistoryPath(paths, current.sourceId, current.revision),
      );
      if (JSON.stringify(history) !== JSON.stringify(current)) {
        throw new Error("The source revision history conflicts with the current record.");
      }
    }
    await atomicWriteJson(sourceRecordPath(paths, current.sourceId), next, MAX_RECORD_BYTES);
    return { outcome: "updated", record: next };
  });
}

export async function removeScientSource(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly expectedRevision: number;
}): Promise<ScientSourceRemovalResult> {
  const paths = await sourceStorePaths(input.root);
  assertSafeIdentifier(input.sourceId, "Source ID");

  return withOperationLock(`${paths.root}:source-write`, async () => {
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

    // Validate the remaining store before the irreversible write. After the
    // record is removed, only best-effort orphan cleanup remains.
    const remaining = (await listScientSourceRecords(paths.root)).filter(
      (record) => record.sourceId !== current.sourceId,
    );
    const referencedPaths = new Set(
      remaining.flatMap((record) =>
        record.attachments.map((attachment) => attachment.relativePath),
      ),
    );
    const attachments = [
      ...new Map(
        current.attachments.map((attachment) => [attachment.relativePath, attachment]),
      ).values(),
    ];
    let removedAttachmentCount = 0;
    let retainedAttachmentCount = 0;

    // Remove the authoritative record first. A crash or cleanup failure can leave
    // an unreferenced immutable blob, but can never leave another source pointing
    // at a file that was removed out from under it.
    await NodeFSP.unlink(recordPath);

    for (const attachment of attachments) {
      if (referencedPaths.has(attachment.relativePath)) {
        retainedAttachmentCount += 1;
        continue;
      }
      const attachmentPath = sourceAttachmentAbsolutePath(paths.root, attachment);
      const state = await snapshot(attachmentPath);
      if (state === "missing") continue;
      if (state !== "file") {
        retainedAttachmentCount += 1;
        continue;
      }
      try {
        await NodeFSP.unlink(attachmentPath);
        removedAttachmentCount += 1;
        await NodeFSP.rmdir(NodePath.dirname(attachmentPath)).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
        });
      } catch {
        // The source is already removed. Retaining an unreferenced blob is safer
        // than reporting a failed command that a user might retry ambiguously.
        retainedAttachmentCount += 1;
      }
    }

    return {
      outcome: "removed",
      sourceId: current.sourceId,
      revision: current.revision,
      removedAttachmentCount,
      retainedAttachmentCount,
    };
  });
}

async function listScientSourceRecordsFromPaths(
  paths: SourceStorePaths,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  const recordsState = await snapshot(paths.records);
  if (recordsState === "missing") return [];
  if (recordsState !== "directory") throw new Error("The Scient source record store is unsafe.");
  const entries = await NodeFSP.readdir(paths.records, { withFileTypes: true });
  const records: ScientSourceRecord[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readBoundedSourceRecord(NodePath.join(paths.records, entry.name));
    if (record.projectId !== paths.identity.projectId) {
      throw new Error(`Source record ${entry.name} belongs to another Scient project.`);
    }
    records.push(record);
  }
  return records.toSorted((left, right) => right.importedAt.localeCompare(left.importedAt));
}

export async function listScientSourceRecords(
  root: string,
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
  root: string,
  operationId: string,
): Promise<ScientSourceImportOperation | null> {
  const paths = await sourceStorePaths(root);
  return readSourceImportOperationFromPaths(paths, operationId);
}

async function readSourceImportOperationFromPaths(
  paths: Awaited<ReturnType<typeof sourceStorePaths>>,
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
  };
  if (operation.projectId !== paths.identity.projectId) {
    throw new Error("The source import operation belongs to another Scient project.");
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
      cached = await withOperationLock(`${paths.root}:${cachedOperationId}`, async () => {
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
    if (operation.projectId !== paths.identity.projectId) {
      throw new Error(`Source operation ${entry.name} belongs to another Scient project.`);
    }
    if (
      operation.state === "running" &&
      operation.items.every((item) => item.state !== "pending")
    ) {
      const operationId = operation.operationId;
      operation = await withOperationLock(`${paths.root}:${operationId}`, async () => {
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
  const [records, activeOperation] = await Promise.all([
    listScientSourceRecords(project.root),
    sourceStorePaths(project.root).then(findActiveOperation),
  ]);
  return { projectState: "initialized", issues: [], records, activeOperation };
}

export async function createSourceImportOperation(input: {
  readonly root: string;
  readonly operationId: string;
  readonly adapter: "zotero" | "local-files";
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides?: ReadonlyArray<string>;
}): Promise<ScientSourceImportOperation> {
  assertSafeIdentifier(input.operationId, "Operation ID");
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
  return withOperationLock(`${paths.root}:active-operation`, async () => {
    const existing = await readSourceImportOperationFromPaths(paths, input.operationId);
    if (existing) {
      const existingKeys = existing.items.map((item) => item.itemKey);
      const existingOverrides = existing.items.flatMap((item) =>
        item.allowPossibleMetadataMatch ? [item.itemKey] : [],
      );
      if (
        existingKeys.join("\0") !== uniqueItemKeys.join("\0") ||
        existingOverrides.join("\0") !== normalizedOverrides.join("\0") ||
        existing.adapter !== input.adapter
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
      throw new Error("Another source import is already running for this project.");
    }
    const now = new Date().toISOString();
    const operation: ScientSourceImportOperation = {
      formatVersion: 1,
      operationId: input.operationId,
      projectId: paths.identity.projectId,
      adapter: input.adapter,
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
  paths: Awaited<ReturnType<typeof sourceStorePaths>>,
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
    formatVersion: 1,
    operationId: completed.operationId,
    projectId: completed.projectId,
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
  readonly root: string;
  readonly operationId: string;
  readonly itemKey: string;
  readonly state: "imported" | "skipped" | "failed";
  readonly duplicateKind?: ScientSourceDuplicateKind;
  readonly sourceId?: string;
  readonly message?: string;
}): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:${input.operationId}`, async () => {
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

export async function cancelSourceImportOperation(
  root: string,
  operationId: string,
): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(root);
  return withOperationLock(`${paths.root}:${operationId}`, async () => {
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
      formatVersion: 1,
      operationId,
      projectId: operation.projectId,
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

function makeSourceId(projectId: string, candidate: ScientSourceCandidate): string {
  const digest = NodeCrypto.createHash("sha256")
    .update([projectId, candidate.sourceKey].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `source_${digest}`;
}

export interface ScientSourcePdfInspection {
  readonly sha256: string;
  readonly byteLength: number;
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
  const sourceHandle = await NodeFSP.open(sourcePath, "r");
  try {
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

function stagedLocalMaterialPaths(
  paths: Awaited<ReturnType<typeof sourceStorePaths>>,
  sourceKey: string,
) {
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
  readonly root: string;
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
  return withOperationLock(`${paths.root}:source-upload`, async () => {
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
      const existing = await inspectScientSourcePdf(materialPaths.pdf);
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
  root: string,
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
  const inspected = await inspectScientSourcePdf(materialPaths.pdf);
  if (inspected.sha256 !== decoded.pdfSha256 || inspected.byteLength !== decoded.byteLength) {
    throw new Error("The staged source PDF changed before metadata was saved.");
  }
  await atomicWriteJson(materialPaths.metadata, decoded, MAX_STAGED_MATERIAL_BYTES);
}

export async function readScientSourceStagedMaterial(
  root: string,
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
  root: string,
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
  root: string,
  sourceKey: string,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  const materialPaths = stagedLocalMaterialPaths(paths, sourceKey);
  await Promise.all([
    NodeFSP.rm(materialPaths.pdf, { force: true }),
    NodeFSP.rm(materialPaths.metadata, { force: true }),
  ]);
}

async function stagePdf(input: {
  readonly paths: Awaited<ReturnType<typeof sourceStorePaths>>;
  readonly operationId: string;
  readonly sourcePath: string;
  readonly fileName?: string;
  readonly expectedPdf?: ScientSourcePdfInspection;
  readonly importedAt: string;
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
    const finalPath = NodePath.join(input.paths.root, SCIENT_SOURCES_DIRECTORY, relativePath);
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
      attachmentId: `pdf_${sha256.slice(0, 24)}`,
      kind: "pdf",
      fileName: safeUploadedFileName(input.fileName ?? NodePath.basename(input.sourcePath)),
      mediaType: "application/pdf",
      sha256,
      byteLength,
      relativePath,
      importedAt: input.importedAt,
    };
  } finally {
    await targetHandle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
    await NodeFSP.rmdir(stagingDirectory).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
    });
  }
}

interface ImportScientSourceInput {
  readonly root: string;
  readonly operationId: string;
  readonly candidate: ScientSourceCandidate;
  readonly pdfPath?: string;
  readonly expectedPdf?: ScientSourcePdfInspection;
  readonly allowPossibleMetadataMatch?: boolean;
}

async function importScientSourceWithRecordLookup(
  input: ImportScientSourceInput,
  lookup: "complete" | "operation-snapshot",
): Promise<ImportedSourceResult> {
  assertSafeIdentifier(input.operationId, "Operation ID");
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:source-write`, async () => {
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
          importedAt,
        })
      : null;
    const duplicate = assessSourceDuplicate({
      candidate: input.candidate,
      existing,
      ...(attachment ? { pdfSha256: attachment.sha256 } : {}),
    });
    if (duplicateBlocksImport(duplicate, input.allowPossibleMetadataMatch ?? false)) {
      return { outcome: "duplicate", record: null, duplicate };
    }
    const sourceId = makeSourceId(paths.identity.projectId, input.candidate);
    // Removing a source removes its current record but deliberately keeps prior
    // immutable revisions. Re-importing that same external source must continue
    // after those revisions rather than collide on the next metadata edit.
    const revision = (await latestSourceHistoryRevision(paths, sourceId)) + 1;
    const abstract =
      abstractDocumentFromSections(input.candidate.abstractSections) ??
      normalizeScientSourceAbstractDocument(input.candidate.abstract);
    const record: ScientSourceRecord = {
      formatVersion: 1,
      sourceId,
      projectId: paths.identity.projectId,
      revision,
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
      externalReferences: input.candidate.externalReferences,
      attachments: attachment ? [attachment] : [],
      fieldProvenance: input.candidate.fieldProvenance,
      importedAt,
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
        ...(attachment ? { pdfSha256: attachment.sha256 } : {}),
      });
      if (concurrentDuplicate.kind === "new") {
        throw new Error("A conflicting source record was created concurrently.");
      }
      return { outcome: "duplicate", record: null, duplicate: concurrentDuplicate };
    }
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
  root: string,
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
  const base = NodePath.resolve(root, SCIENT_SOURCES_DIRECTORY);
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
