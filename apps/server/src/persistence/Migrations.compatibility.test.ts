import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

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

          const executed = yield* runMigrations();
          assert.deepStrictEqual(
            executed,
            previousId === 52
              ? [[53, "ProjectionThreadPullRequests"]]
              : [
                  [51, "ProjectionThreadBranchPullRequest"],
                  [52, "ProjectionThreadsActiveOrderKey"],
                  [53, "ProjectionThreadPullRequests"],
                ],
          );
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
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
          assert.ok(columns.some((column) => column.name === "branch_pull_request_json"));
          assert.ok(columns.some((column) => column.name === "active_order_key"));
          assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_pull_requests`, []);
          assert.isEmpty(yield* runMigrations());
        }),
      );
    },
  );
}

it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))("fresh migration compatibility", (it) => {
  it.effect("installs the complete manifest without reusing retired migration 50", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      const rows = yield* sql`SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= 50 ORDER BY migration_id`;
      assert.deepStrictEqual(rows, [
        { migration_id: 51, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 52, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 53, name: "ProjectionThreadPullRequests" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_pull_requests`, []);
      assert.isEmpty(yield* runMigrations());
    }),
  );
});
