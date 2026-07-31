/** Bounded, projection-table query for governed external thread reads. */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";

export const EXTERNAL_THREAD_READ_MAX_MESSAGES = 100;

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
  }) => Effect.Effect<
    ExternalIntegrationThreadReadPage,
    ExternalIntegrationThreadReadError | PersistenceSqlError
  >;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(Math.trunc(value), EXTERNAL_THREAD_READ_MAX_MESSAGES));
}

function cursorEnd(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return total;
  if (!/^(0|[1-9][0-9]*)$/u.test(cursor)) {
    throw new ExternalIntegrationThreadReadError(
      "invalid_cursor",
      "Thread cursor must be a canonical non-negative message index.",
    );
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed > total) {
    throw new ExternalIntegrationThreadReadError(
      "invalid_cursor",
      "Thread cursor is outside the current message history.",
    );
  }
  return parsed;
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
            const end = yield* Effect.try({
              try: () => cursorEnd(input.cursor, totalMessages),
              catch: (cause) =>
                cause instanceof ExternalIntegrationThreadReadError
                  ? cause
                  : new ExternalIntegrationThreadReadError(
                      "invalid_cursor",
                      "Thread cursor is invalid.",
                    ),
            });
            const start = Math.max(0, end - limit);
            const rows = yield* sql<{
              readonly role: string;
              readonly text: string;
              readonly createdAt: string;
            }>`
              SELECT role, text, created_at AS "createdAt"
              FROM projection_thread_messages
              WHERE thread_id = ${input.threadId}
              ORDER BY created_at ASC, message_id ASC
              LIMIT ${end - start} OFFSET ${start}
            `;
            return {
              threadId: thread.threadId,
              projectId: thread.projectId,
              title: thread.title,
              status: thread.status,
              archived: thread.archivedAt !== null,
              messages: rows.map((message, index) => ({
                index: start + index,
                role: message.role,
                text: message.text,
                createdAt: message.createdAt,
              })),
              totalMessages,
              nextCursor: start > 0 ? String(start) : null,
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
