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

import { assessSourceDuplicate } from "./duplicates.ts";
import {
  ScientSourceImportOperation,
  ScientSourceImportReceipt,
  ScientSourceRecord,
  type ScientSourceAttachment,
  type ScientSourceCandidate,
  type ScientSourceDuplicateAssessment,
  type ScientSourcesOverview,
} from "./model.ts";

export const SCIENT_SOURCES_DIRECTORY = ".scient/sources";
export const SCIENT_SOURCE_RECORDS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/records`;
export const SCIENT_SOURCE_FILES_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/files/sha256`;
export const SCIENT_SOURCE_OPERATIONS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/operations`;
export const SCIENT_SOURCE_RECEIPTS_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/receipts`;
export const SCIENT_SOURCE_STAGING_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/staging`;

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const operationLocks = new Map<string, Promise<unknown>>();

export interface ImportedSourceResult {
  readonly outcome: "imported" | "duplicate";
  readonly record: ScientSourceRecord | null;
  readonly duplicate: ScientSourceDuplicateAssessment;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is not a safe portable identifier.`);
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

async function ensureDirectory(filePath: string): Promise<void> {
  await NodeFSP.mkdir(filePath, { recursive: true });
  if ((await snapshot(filePath)) !== "directory") {
    throw new Error(`${NodePath.basename(filePath)} is not a safe directory.`);
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(NodePath.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(stableJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await NodeFSP.rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}

async function atomicCreateJson(filePath: string, value: unknown): Promise<boolean> {
  await ensureDirectory(NodePath.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(stableJson(value), "utf8");
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

async function sourceStorePaths(root: string): Promise<{
  readonly root: string;
  readonly identity: ScientProjectIdentity;
  readonly records: string;
  readonly files: string;
  readonly operations: string;
  readonly receipts: string;
  readonly staging: string;
}> {
  const identity = await readScientProjectIdentity(root);
  if (identity === null) {
    throw new Error("This folder is not an initialized Scient project.");
  }
  const resolvedRoot = await NodeFSP.realpath(root);
  return {
    root: resolvedRoot,
    identity,
    records: NodePath.join(resolvedRoot, SCIENT_SOURCE_RECORDS_DIRECTORY),
    files: NodePath.join(resolvedRoot, SCIENT_SOURCE_FILES_DIRECTORY),
    operations: NodePath.join(resolvedRoot, SCIENT_SOURCE_OPERATIONS_DIRECTORY),
    receipts: NodePath.join(resolvedRoot, SCIENT_SOURCE_RECEIPTS_DIRECTORY),
    staging: NodePath.join(resolvedRoot, SCIENT_SOURCE_STAGING_DIRECTORY),
  };
}

export async function listScientSourceRecords(
  root: string,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  const paths = await sourceStorePaths(root);
  const recordsState = await snapshot(paths.records);
  if (recordsState === "missing") return [];
  if (recordsState !== "directory") throw new Error("The Scient source record store is unsafe.");
  const entries = await NodeFSP.readdir(paths.records, { withFileTypes: true });
  const records: ScientSourceRecord[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readBoundedJson(
      NodePath.join(paths.records, entry.name),
      MAX_RECORD_BYTES,
      ScientSourceRecord,
    );
    if (record.projectId !== paths.identity.projectId) {
      throw new Error(`Source record ${entry.name} belongs to another Scient project.`);
    }
    records.push(record);
  }
  return records.toSorted((left, right) => right.importedAt.localeCompare(left.importedAt));
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
  const filePath = operationPath(paths.operations, operationId);
  if ((await snapshot(filePath)) === "missing") return null;
  const operation = await readBoundedJson(
    filePath,
    MAX_OPERATION_BYTES,
    ScientSourceImportOperation,
  );
  if (operation.projectId !== paths.identity.projectId) {
    throw new Error("The source import operation belongs to another Scient project.");
  }
  return operation;
}

async function findActiveOperation(root: string): Promise<ScientSourceImportOperation | null> {
  const paths = await sourceStorePaths(root);
  if ((await snapshot(paths.operations)) === "missing") return null;
  const entries = await NodeFSP.readdir(paths.operations, { withFileTypes: true });
  const operations: ScientSourceImportOperation[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let operation = await readBoundedJson(
      NodePath.join(paths.operations, entry.name),
      MAX_OPERATION_BYTES,
      ScientSourceImportOperation,
    );
    if (
      operation.state === "running" &&
      operation.items.every((item) => item.state !== "pending")
    ) {
      operation = await finishOperationIfSettled(paths, operation);
    }
    if (operation.projectId === paths.identity.projectId && operation.state === "running") {
      operations.push(operation);
    }
  }
  return (
    operations.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
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
    findActiveOperation(project.root),
  ]);
  return { projectState: "initialized", issues: [], records, activeOperation };
}

export async function createSourceImportOperation(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}): Promise<ScientSourceImportOperation> {
  assertSafeIdentifier(input.operationId, "Operation ID");
  const uniqueItemKeys = [...new Set(input.itemKeys)];
  if (uniqueItemKeys.length === 0) throw new Error("Choose at least one Zotero item to import.");
  for (const itemKey of uniqueItemKeys) assertSafeIdentifier(itemKey, "Zotero item key");
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:${input.operationId}`, async () => {
    const existing = await readSourceImportOperation(paths.root, input.operationId);
    if (existing) {
      const existingKeys = existing.items.map((item) => item.itemKey);
      if (existingKeys.join("\0") !== uniqueItemKeys.join("\0")) {
        throw new Error("This operation ID was already used for another import selection.");
      }
      return existing;
    }
    const now = new Date().toISOString();
    const operation: ScientSourceImportOperation = {
      formatVersion: 1,
      operationId: input.operationId,
      projectId: paths.identity.projectId,
      state: "running",
      createdAt: now,
      updatedAt: now,
      items: uniqueItemKeys.map((itemKey) => ({
        itemKey,
        state: "pending",
        sourceId: null,
        message: null,
      })),
    };
    await atomicWriteJson(operationPath(paths.operations, input.operationId), operation);
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
  await atomicWriteJson(operationPath(paths.operations, completed.operationId), completed);
  await atomicWriteJson(operationPath(paths.receipts, completed.operationId), receipt);
  return completed;
}

export async function updateSourceImportOperationItem(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKey: string;
  readonly state: "imported" | "skipped" | "failed";
  readonly sourceId?: string;
  readonly message?: string;
}): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(paths.root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    if (!operation.items.some((item) => item.itemKey === input.itemKey)) {
      throw new Error("The Zotero item is not part of this import operation.");
    }
    const updated: ScientSourceImportOperation = {
      ...operation,
      updatedAt: new Date().toISOString(),
      items: operation.items.map((item) =>
        item.itemKey === input.itemKey
          ? {
              ...item,
              state: input.state,
              sourceId: input.sourceId ?? null,
              message: input.message ?? null,
            }
          : item,
      ),
    };
    await atomicWriteJson(operationPath(paths.operations, input.operationId), updated);
    return finishOperationIfSettled(paths, updated);
  });
}

export async function cancelSourceImportOperation(
  root: string,
  operationId: string,
): Promise<ScientSourceImportOperation> {
  const paths = await sourceStorePaths(root);
  return withOperationLock(`${paths.root}:${operationId}`, async () => {
    const operation = await readSourceImportOperation(paths.root, operationId);
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
    await atomicWriteJson(operationPath(paths.operations, operationId), cancelled);
    await atomicWriteJson(operationPath(paths.receipts, operationId), receipt);
    return cancelled;
  });
}

function makeSourceId(projectId: string, candidate: ScientSourceCandidate): string {
  const reference = candidate.externalReference;
  const digest = NodeCrypto.createHash("sha256")
    .update([projectId, reference.system, reference.libraryId, reference.itemKey].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `source_${digest}`;
}

async function stagePdf(input: {
  readonly paths: Awaited<ReturnType<typeof sourceStorePaths>>;
  readonly operationId: string;
  readonly sourcePath: string;
  readonly importedAt: string;
}): Promise<ScientSourceAttachment> {
  const sourceStats = await NodeFSP.lstat(input.sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error("The Zotero PDF attachment is not a safe regular file.");
  }
  if (sourceStats.size > MAX_PDF_BYTES) {
    throw new Error("The Zotero PDF attachment exceeds the 512 MiB import limit.");
  }
  const stagingDirectory = NodePath.join(input.paths.staging, input.operationId);
  await ensureDirectory(stagingDirectory);
  const temporaryPath = NodePath.join(stagingDirectory, `pdf-${NodeCrypto.randomUUID()}.tmp`);
  let sourceHandle: NodeFSP.FileHandle | null = null;
  let targetHandle: NodeFSP.FileHandle | null = null;
  try {
    sourceHandle = await NodeFSP.open(input.sourcePath, "r");
    targetHandle = await NodeFSP.open(temporaryPath, "wx", 0o600);
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
      await targetHandle.write(chunk);
    }
    const finalSourceStats = await sourceHandle.stat();
    if (
      finalSourceStats.size !== sourceStats.size ||
      finalSourceStats.mtimeMs !== sourceStats.mtimeMs
    ) {
      throw new Error("The Zotero PDF changed while Scient was importing it. Try again.");
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    await sourceHandle.close();
    sourceHandle = null;
    if (header.toString("ascii") !== "%PDF-") {
      throw new Error("The selected Zotero attachment is not a valid PDF file.");
    }
    const sha256 = digest.digest("hex");
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
      fileName: NodePath.basename(input.sourcePath),
      mediaType: "application/pdf",
      sha256,
      byteLength,
      relativePath,
      importedAt: input.importedAt,
    };
  } finally {
    await Promise.all([sourceHandle?.close(), targetHandle?.close()]);
    await NodeFSP.rm(temporaryPath, { force: true });
    await NodeFSP.rmdir(stagingDirectory).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
    });
  }
}

export async function importScientSource(input: {
  readonly root: string;
  readonly operationId: string;
  readonly candidate: ScientSourceCandidate;
  readonly pdfPath?: string;
}): Promise<ImportedSourceResult> {
  assertSafeIdentifier(input.operationId, "Operation ID");
  const paths = await sourceStorePaths(input.root);
  return withOperationLock(`${paths.root}:source-import`, async () => {
    const existing = await listScientSourceRecords(paths.root);
    const importedAt = new Date().toISOString();
    const preliminaryDuplicate = assessSourceDuplicate({ candidate: input.candidate, existing });
    if (preliminaryDuplicate.kind !== "new") {
      return { outcome: "duplicate", record: null, duplicate: preliminaryDuplicate };
    }
    const attachment = input.pdfPath
      ? await stagePdf({
          paths,
          operationId: input.operationId,
          sourcePath: input.pdfPath,
          importedAt,
        })
      : null;
    const duplicate = assessSourceDuplicate({
      candidate: input.candidate,
      existing,
      ...(attachment ? { pdfSha256: attachment.sha256 } : {}),
    });
    if (duplicate.kind !== "new") {
      return { outcome: "duplicate", record: null, duplicate };
    }
    const sourceId = makeSourceId(paths.identity.projectId, input.candidate);
    const record: ScientSourceRecord = {
      formatVersion: 1,
      sourceId,
      projectId: paths.identity.projectId,
      revision: 1,
      type: input.candidate.type,
      title: input.candidate.title,
      creators: input.candidate.creators,
      issuedRaw: input.candidate.issuedRaw,
      issuedYear: input.candidate.issuedYear,
      identifiers: input.candidate.identifiers,
      abstract: input.candidate.abstract,
      containerTitle: input.candidate.containerTitle,
      publisher: input.candidate.publisher,
      volume: input.candidate.volume,
      issue: input.candidate.issue,
      pages: input.candidate.pages,
      language: input.candidate.language,
      url: input.candidate.url,
      tags: input.candidate.tags,
      externalReferences: [input.candidate.externalReference],
      attachments: attachment ? [attachment] : [],
      fieldProvenance: input.candidate.fieldProvenance,
      importedAt,
    };
    const recordPath = NodePath.join(paths.records, `${sourceId}.json`);
    if (!(await atomicCreateJson(recordPath, record))) {
      const concurrentRecords = await listScientSourceRecords(paths.root);
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
    return { outcome: "imported", record, duplicate };
  });
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
