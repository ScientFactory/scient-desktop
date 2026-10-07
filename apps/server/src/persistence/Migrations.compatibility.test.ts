import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

for (const previousId of [49, 50, 52] as const) {
  it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))(
    `migration compatibility after ${previousId}`,
    (it) => {
      it.effect("runs every pending step without rewriting recorded history or session data", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: previousId === 50 ? 49 : previousId });
          if (previousId === 50) {
            yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN last_error_reason TEXT`;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
              VALUES (50, 'ProjectionSessionErrorReason')`;
          }
          const historyBefore =
            yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          yield* sql`INSERT INTO projection_thread_sessions
            (thread_id, status, provider_name, runtime_mode, last_error, updated_at)
            VALUES ('legacy', 'error', 'pi', 'full-access', 'Old error', '2026-09-06T00:00:00.000Z')`;

          yield* runMigrations();
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_migrations
              WHERE migration_id <= ${previousId} ORDER BY migration_id`,
            historyBefore,
          );
          const rows = yield* sql`SELECT last_error, updated_at
            FROM projection_thread_sessions WHERE thread_id = 'legacy'`;
          assert.deepStrictEqual(rows, [
            { last_error: "Old error", updated_at: "2026-09-06T00:00:00.000Z" },
          ]);
          const completedLedger =
            yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          yield* runMigrations();
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
            completedLedger,
          );
        }),
      );
    },
  );
}

it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))("migration ledger collisions", (it) => {
  it.effect(
    "refuses a conflicting recorded migration without rewriting the ledger or applying later steps",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 40 });
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (41, 'ForeignBuildMigration')`;
        const original = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.equal((yield* Effect.exit(runMigrations()))._tag, "Failure");
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          original,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'`,
          [],
        );
      }),
  );
});
