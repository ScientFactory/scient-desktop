import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("unreleased migration compatibility", (it) => {
  it.effect("can reopen a development database with the retired error-reason column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN last_error_reason TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (50, 'ProjectionSessionErrorReason')`;
      yield* sql`INSERT INTO projection_thread_sessions
        (thread_id, status, provider_name, runtime_mode, last_error, updated_at)
        VALUES ('legacy', 'error', 'pi', 'full-access', 'Old error', '2026-09-06T00:00:00.000Z')`;
      assert.isEmpty(yield* runMigrations());
      const rows = yield* sql<{ last_error: string }>`SELECT last_error
        FROM projection_thread_sessions WHERE thread_id = 'legacy'`;
      assert.deepEqual(rows, [{ last_error: "Old error" }]);
    }),
  );
});
