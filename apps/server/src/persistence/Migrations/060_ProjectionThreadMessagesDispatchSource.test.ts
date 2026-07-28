import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("060_ProjectionThreadMessagesDispatchSource", () => {
  it.effect("adds agent provenance without breaking legacy message reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* runMigrations();
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_table_info('projection_thread_messages')
        WHERE name = 'dispatch_source'
      `;
      assert.deepEqual(columns, [{ name: "dispatch_source" }]);

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          role,
          text,
          dispatch_source,
          is_streaming,
          source,
          created_at,
          updated_at
        ) VALUES (
          'message-agent',
          'thread-1',
          'user',
          'continue',
          'agent',
          0,
          'native',
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z'
        )
      `;

      // A released reader selects the old column set and never has to decode
      // the additive provenance value.
      const legacyRows = yield* sql<{
        readonly messageId: string;
        readonly dispatchOrigin: string | null;
      }>`
        SELECT
          message_id AS "messageId",
          dispatch_origin AS "dispatchOrigin"
        FROM projection_thread_messages
      `;
      assert.deepEqual(legacyRows, [{ messageId: "message-agent", dispatchOrigin: null }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
