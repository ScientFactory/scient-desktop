/** Bounded, projection-table query for governed external thread reads. */
import { createHash } from "node:crypto";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";

export const EXTERNAL_THREAD_READ_MAX_MESSAGES = 100;
export const EXTERNAL_THREAD_READ_MAX_MESSAGE_CHARS = 20_000;

export class ExternalIntegrationThreadReadError extends Error {
  constructor(
    readonly code: "thread_not_found" | "invalid_cursor",
    message: string,
  ) {
    super(message);
  }
}

export interface ExternalIntegrationThreadReadMessage {
  readonly index: number;
  readonly role: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly createdAt: string;
}

export interface ExternalIntegrationThreadReadPage {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly archived: boolean;
  readonly messages: ReadonlyArray<ExternalIntegrationThreadReadMessage>;
  readonly totalMessages: number;
  readonly nextCursor: string | null;
}

export interface ExternalIntegrationThreadReadQueryShape {
  readonly readPage: (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly cursor?: string;
    readonly messageLimit?: number;
    readonly maxMessageChars?: number;
  }) => Effect.Effect<
    ExternalIntegrationThreadReadPage,
    ExternalIntegrationThreadReadError | PersistenceSqlError
  >;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(Math.trunc(value), EXTERNAL_THREAD_READ_MAX_MESSAGES));
}

function messageCharLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1_500;
  return Math.max(1, Math.min(Math.trunc(value), EXTERNAL_THREAD_READ_MAX_MESSAGE_CHARS));
}

interface ThreadReadCursor {
  readonly scopeHash: string;
  readonly beforeCreatedAt: string;
  readonly beforeMessageId: string;
}

function cursorScope(projectId: string, threadId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["scient-external-thread-cursor-v1", projectId, threadId]))
    .digest("hex");
}

function encodeCursor(input: ThreadReadCursor): string {
  return Buffer.from(
    JSON.stringify([1, input.scopeHash, input.beforeCreatedAt, input.beforeMessageId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  projectId: string,
  threadId: string,
): ThreadReadCursor | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length < 1 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error("cursor encoding");
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical cursor");
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      decoded[0] !== 1 ||
      typeof decoded[1] !== "string" ||
      typeof decoded[2] !== "string" ||
      decoded[2].length < 1 ||
      Buffer.byteLength(decoded[2], "utf8") > 1_024 ||
      typeof decoded[3] !== "string" ||
      decoded[3].length < 1 ||
      Buffer.byteLength(decoded[3], "utf8") > 512 ||
      decoded[1] !== cursorScope(projectId, threadId)
    ) {
      throw new Error("cursor shape");
    }
    return {
      scopeHash: decoded[1],
      beforeCreatedAt: decoded[2],
      beforeMessageId: decoded[3],
    };
  } catch {
    throw new ExternalIntegrationThreadReadError(
      "invalid_cursor",
      "Thread cursor is malformed or belongs to another thread.",
    );
  }
}

function sqlError(operation: string, cause: unknown): PersistenceSqlError {
  return new PersistenceSqlError({ operation, detail: `Failed to execute ${operation}`, cause });
}

/**
 * Reads only the requested page, while the count and project/thread verification
 * share the same SQLite transaction snapshot. This seam intentionally does not
 * hydrate attachments, paths, provider diagnostics, or the UI's capped detail model.
 */
export const makeExternalIntegrationThreadReadQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readPage: ExternalIntegrationThreadReadQueryShape["readPage"] = (input) =>
    Effect.suspend(() => {
      const limit = pageLimit(input.messageLimit);
      const chars = messageCharLimit(input.maxMessageChars);
      let cursor: ThreadReadCursor | null;
      try {
        cursor = decodeCursor(input.cursor, input.projectId, input.threadId);
      } catch (cause) {
        return Effect.fail(
          cause instanceof ExternalIntegrationThreadReadError
            ? cause
            : new ExternalIntegrationThreadReadError("invalid_cursor", "Thread cursor is invalid."),
        );
      }
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = (yield* sql<{
              readonly threadId: string;
              readonly projectId: string;
              readonly title: string;
              readonly archivedAt: string | null;
              readonly status: string;
            }>`
                SELECT
                  threads.thread_id AS "threadId",
                  threads.project_id AS "projectId",
                  threads.title,
                  threads.archived_at AS "archivedAt",
                  COALESCE(
                    (
                      SELECT turns.state
                      FROM projection_turns AS turns
                      WHERE turns.thread_id = threads.thread_id AND turns.turn_id IS NOT NULL
                      ORDER BY turns.requested_at DESC, turns.turn_id DESC
                      LIMIT 1
                    ),
                    (
                      SELECT sessions.status
                      FROM projection_thread_sessions AS sessions
                      WHERE sessions.thread_id = threads.thread_id
                      LIMIT 1
                    ),
                    'idle'
                  ) AS status
                FROM projection_threads AS threads
                WHERE threads.thread_id = ${input.threadId}
                  AND threads.project_id = ${input.projectId}
                  AND threads.deleted_at IS NULL
                LIMIT 1
              `)[0];
            if (thread === undefined) {
              return yield* Effect.fail(
                new ExternalIntegrationThreadReadError(
                  "thread_not_found",
                  "Thread was not found in the granted project.",
                ),
              );
            }
            const totalMessages = Number(
              (yield* sql<{ readonly count: number }>`
                  SELECT COUNT(*) AS count
                  FROM projection_thread_messages
                  WHERE thread_id = ${input.threadId}
                `)[0]?.count ?? 0,
            );
            if (cursor !== null) {
              const cursorAnchor = yield* sql<{ readonly present: number }>`
                SELECT 1 AS present
                FROM projection_thread_messages
                WHERE thread_id = ${input.threadId}
                  AND created_at = ${cursor.beforeCreatedAt}
                  AND message_id = ${cursor.beforeMessageId}
                LIMIT 1
              `;
              if (cursorAnchor.length === 0) {
                return yield* Effect.fail(
                  new ExternalIntegrationThreadReadError(
                    "invalid_cursor",
                    "Thread cursor no longer names a valid continuation boundary.",
                  ),
                );
              }
            }
            const rows = yield* sql<{
              readonly messageId: string;
              readonly role: string;
              readonly text: string;
              readonly truncated: number;
              readonly createdAt: string;
            }>`
              SELECT
                message_id AS "messageId",
                role,
                substr(text, 1, ${chars}) AS text,
                CASE WHEN length(text) > ${chars} THEN 1 ELSE 0 END AS truncated,
                created_at AS "createdAt"
              FROM projection_thread_messages
              WHERE thread_id = ${input.threadId}
                AND (
                  ${cursor === null ? 1 : 0}
                  OR created_at < ${cursor?.beforeCreatedAt ?? ""}
                  OR (
                    created_at = ${cursor?.beforeCreatedAt ?? ""}
                    AND message_id < ${cursor?.beforeMessageId ?? ""}
                  )
                )
              ORDER BY created_at DESC, message_id DESC
              LIMIT ${limit + 1}
            `;
            const pageDescending = rows.slice(0, limit);
            const oldest = pageDescending.at(-1);
            const precedingCount =
              oldest === undefined
                ? 0
                : Number(
                    (yield* sql<{ readonly count: number }>`
                        SELECT COUNT(*) AS count
                        FROM projection_thread_messages
                        WHERE thread_id = ${input.threadId}
                          AND (
                            created_at < ${oldest.createdAt}
                            OR (created_at = ${oldest.createdAt} AND message_id < ${oldest.messageId})
                          )
                      `)[0]?.count ?? 0,
                  );
            const pageAscending = pageDescending.toReversed();
            return {
              threadId: thread.threadId,
              projectId: thread.projectId,
              title: thread.title,
              status: thread.status,
              archived: thread.archivedAt !== null,
              messages: pageAscending.map((message, index) => ({
                index: precedingCount + index,
                role: message.role,
                text: message.text,
                truncated: message.truncated === 1,
                createdAt: message.createdAt,
              })),
              totalMessages,
              nextCursor:
                rows.length > limit && oldest !== undefined
                  ? encodeCursor({
                      scopeHash: cursorScope(input.projectId, input.threadId),
                      beforeCreatedAt: oldest.createdAt,
                      beforeMessageId: oldest.messageId,
                    })
                  : null,
            } satisfies ExternalIntegrationThreadReadPage;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ExternalIntegrationThreadReadError
              ? cause
              : sqlError("ExternalIntegrationThreadReadQuery.readPage", cause),
          ),
        );
    });

  return { readPage } satisfies ExternalIntegrationThreadReadQueryShape;
});
