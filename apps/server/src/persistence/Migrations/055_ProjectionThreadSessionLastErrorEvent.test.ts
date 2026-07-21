import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const projectionThreadSessionColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_sessions')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

describe("055_ProjectionThreadSessionLastErrorEvent", () => {
  it.effect("adds and round-trips the last error metadata columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.notInclude(yield* projectionThreadSessionColumnNames(sql), "last_error_event_id");
      assert.notInclude(yield* projectionThreadSessionColumnNames(sql), "last_error_class");

      yield* runMigrations();
      yield* runMigrations();

      assert.include(yield* projectionThreadSessionColumnNames(sql), "last_error_event_id");
      assert.include(yield* projectionThreadSessionColumnNames(sql), "last_error_class");

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          runtime_mode,
          last_error,
          last_error_event_id,
          last_error_class,
          updated_at
        )
        VALUES (
          'thread-auth-error',
          'error',
          'full-access',
          'Authentication required',
          'event-auth-error',
          'authentication_error',
          '2026-07-21T10:00:00.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly lastErrorEventId: string | null;
        readonly lastErrorClass: string | null;
      }>`
        SELECT
          last_error_event_id AS "lastErrorEventId",
          last_error_class AS "lastErrorClass"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-auth-error'
      `;
      assert.deepEqual(rows, [
        {
          lastErrorEventId: "event-auth-error",
          lastErrorClass: "authentication_error",
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
