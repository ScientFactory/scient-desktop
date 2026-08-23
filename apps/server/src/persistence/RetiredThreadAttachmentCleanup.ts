// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

interface ThreadRow {
  readonly threadId: string;
}

export interface RetiredThreadFilesystemPaths {
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly terminalLogsDir: string;
  readonly providerLogsDir: string;
}

function readDirectory(directory: string): NodeFS.Dirent[] | Error {
  try {
    return NodeFS.readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    return cause instanceof Error ? cause : new Error(String(cause));
  }
}

function removeFile(filePath: string): Error | null {
  try {
    NodeFS.rmSync(filePath, { force: true });
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
}

function attachmentSegment(threadId: string): string | Error {
  const segment = toSafeThreadAttachmentSegment(threadId);
  return (
    segment ?? new Error(`Cannot derive a safe file segment for retired thread '${threadId}'.`)
  );
}

function removeOwnedAttachmentFiles(
  directory: string,
  threadId: string,
  activeThreadSegments: ReadonlySet<string>,
): Error | null {
  const segment = attachmentSegment(threadId);
  if (segment instanceof Error) return segment;
  if (activeThreadSegments.has(segment)) {
    return new Error(
      `Retired thread '${threadId}' shares attachment segment '${segment}' with an active thread.`,
    );
  }
  const entries = readDirectory(directory);
  if (entries instanceof Error) return entries;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const attachmentId = parseAttachmentIdFromRelativePath(entry.name);
    if (attachmentId === null || parseThreadSegmentFromAttachmentId(attachmentId) !== segment) {
      continue;
    }
    const error = removeFile(NodePath.join(directory, entry.name));
    if (error !== null) return error;
  }
  return null;
}

function terminalPrefix(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function legacyTerminalFileName(threadId: string): string {
  return `${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`;
}

function isTerminalFileForThread(fileName: string, threadId: string): boolean {
  const prefix = terminalPrefix(threadId);
  return (
    fileName === `${prefix}.log` ||
    (fileName.startsWith(`${prefix}_`) && fileName.endsWith(".log")) ||
    fileName === legacyTerminalFileName(threadId)
  );
}

function removeOwnedTerminalLogs(
  directory: string,
  threadId: string,
  activeThreadIds: ReadonlyArray<string>,
): Error | null {
  const entries = readDirectory(directory);
  if (entries instanceof Error) return entries;
  for (const entry of entries) {
    if (!entry.isFile() || !isTerminalFileForThread(entry.name, threadId)) continue;
    if (
      activeThreadIds.some((activeThreadId) => isTerminalFileForThread(entry.name, activeThreadId))
    ) {
      return new Error(
        `Retired thread '${threadId}' shares terminal history '${entry.name}' with an active thread.`,
      );
    }
    const error = removeFile(NodePath.join(directory, entry.name));
    if (error !== null) return error;
  }
  return null;
}

function removeOwnedProviderLogs(
  directory: string,
  threadId: string,
  activeThreadSegments: ReadonlySet<string>,
): Error | null {
  const segment = attachmentSegment(threadId);
  if (segment instanceof Error) return segment;
  if (activeThreadSegments.has(segment)) {
    return new Error(
      `Retired thread '${threadId}' shares provider-log segment '${segment}' with an active thread.`,
    );
  }
  const entries = readDirectory(directory);
  if (entries instanceof Error) return entries;
  const suffixPattern = new RegExp(`\\.${segment}\\.log(?:\\.\\d+)?$`, "u");
  for (const entry of entries) {
    if (!entry.isFile() || !suffixPattern.test(entry.name)) continue;
    const error = removeFile(NodePath.join(directory, entry.name));
    if (error !== null) return error;
  }
  return null;
}

function queueFileNames(threadId: string): ReadonlyArray<string> {
  const hash = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  const legacyName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(threadId)
    ? `${threadId}.json`
    : null;
  return legacyName === null ? [`${hash}.json`] : [`${hash}.json`, legacyName];
}

function removeOwnedQueueFiles(
  stateDir: string,
  threadId: string,
  activeThreadIds: ReadonlyArray<string>,
): Error | null {
  const queueDir = NodePath.join(stateDir, "scient", "thread-queue");
  const activeFileNames = new Set(activeThreadIds.flatMap(queueFileNames));
  for (const fileName of queueFileNames(threadId)) {
    if (activeFileNames.has(fileName)) {
      return new Error(
        `Retired thread '${threadId}' shares queue file '${fileName}' with an active thread.`,
      );
    }
    const error = removeFile(NodePath.join(queueDir, fileName));
    if (error !== null) return error;
  }
  return null;
}

function removeOwnedThreadFiles(
  paths: RetiredThreadFilesystemPaths,
  threadId: string,
  activeThreadIds: ReadonlyArray<string>,
  activeThreadSegments: ReadonlySet<string>,
): Error | null {
  return (
    removeOwnedAttachmentFiles(paths.attachmentsDir, threadId, activeThreadSegments) ??
    removeOwnedTerminalLogs(paths.terminalLogsDir, threadId, activeThreadIds) ??
    removeOwnedProviderLogs(paths.providerLogsDir, threadId, activeThreadSegments) ??
    removeOwnedQueueFiles(paths.stateDir, threadId, activeThreadIds)
  );
}

/**
 * Completes migration 43's filesystem half. A failed thread remains in the
 * cleanup table so the next startup retries it. Ambiguous sanitized filenames
 * fail closed rather than deleting data that could belong to an active thread.
 */
export const cleanupRetiredThreadFilesystem = Effect.fn("cleanupRetiredThreadFilesystem")(
  function* (paths: RetiredThreadFilesystemPaths) {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'retired_projectless_thread_cleanup'
    `;
    if (tables.length === 0) return;

    const retiredThreads = yield* sql<ThreadRow>`
      SELECT thread_id AS "threadId"
      FROM retired_projectless_thread_cleanup
      ORDER BY thread_id ASC
    `;
    const activeThreads = yield* sql<ThreadRow>`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      ORDER BY thread_id ASC
    `;
    const activeThreadIds = activeThreads.map((thread) => thread.threadId);
    const activeThreadSegments = new Set(
      activeThreadIds.flatMap((threadId) => {
        const segment = toSafeThreadAttachmentSegment(threadId);
        return segment === null ? [] : [segment];
      }),
    );

    for (const retiredThread of retiredThreads) {
      const error = removeOwnedThreadFiles(
        paths,
        retiredThread.threadId,
        activeThreadIds,
        activeThreadSegments,
      );
      if (error !== null) {
        yield* Effect.logWarning("Retired thread filesystem cleanup will retry", {
          threadId: retiredThread.threadId,
          error: error.message,
        });
        continue;
      }
      yield* sql`
        DELETE FROM retired_projectless_thread_cleanup
        WHERE thread_id = ${retiredThread.threadId}
      `;
    }
  },
);
