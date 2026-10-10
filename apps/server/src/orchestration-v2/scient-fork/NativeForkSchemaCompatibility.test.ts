import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { makeForkLineageQueries, toForkLineageMarker } from "../legacy/LegacyForkLineageReader.ts";
import { runScientMigrations, SCIENT_MIGRATIONS } from "./scientMigrator.ts";

it.effect.each(
  (["Scient", "T3"] as const).map((first) => ({
    caseTitle: `native database initialization preserves independent migration ledgers: ${first} first`,
    first,
  })),
)("$caseTitle", ({ first }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (first === "Scient") {
      yield* runScientMigrations(sql);
      yield* runMigrations();
    } else {
      yield* runMigrations();
      yield* runScientMigrations(sql);
    }
    const t3 =
      yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
    const scient = yield* sql<{
      migration_id: number;
      name: string;
      created_at: string;
    }>`SELECT migration_id, name, created_at FROM scient_schema_migrations ORDER BY migration_id`;
    assert.deepEqual(
      scient.map((row) => row.migration_id),
      SCIENT_MIGRATIONS.map((migration) => migration.id),
    );
    assert.isTrue(t3.length > 0);
    assert.isTrue(scient.length > 0);
    const names = new Set(t3.map((row) => row.name));
    assert.isTrue(scient.every((row) => !names.has(row.name)));
    assert.isTrue(scient.some((row) => row.migration_id === 3));
    assert.isTrue(t3.some((row) => row.migration_id === 3));
    yield* runMigrations();
    assert.deepEqual(yield* runScientMigrations(sql), []);
    assert.deepEqual(
      yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`,
      t3,
    );
    assert.deepEqual(
      yield* sql`SELECT migration_id, name, created_at FROM scient_schema_migrations ORDER BY migration_id`,
      scient,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "native private lineage reads normalized prototype identity without adopting V1 lifecycle or provider authority",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE scient_schema_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`;
      yield* sql`INSERT INTO scient_schema_migrations VALUES (1, 'durable-thread-forks', '2026-07-01T10:00:00.000Z'), (2, 'durable-provider-bootstrap', '2026-07-02T12:00:00.000Z')`;
      yield* sql`CREATE TABLE scient_thread_lineage (thread_id TEXT PRIMARY KEY, forked_from_thread_id TEXT, fork_point_turn_count INTEGER, workspace_mode TEXT, fidelity_mode TEXT, baseline_turn_id TEXT, created_at TEXT)`;
      yield* sql`INSERT INTO scient_thread_lineage VALUES ('proto-a', 'origin-a', 2, 'local', 'chat-only', 'baseline-a', '2026-07-10T00:00:00.000Z'), ('proto-b', 'origin-b', 1, 'new-worktree', 'replay', 'baseline-b', '2026-07-11T00:00:00.000Z')`;
      yield* runScientMigrations(sql);
      const rows = yield* sql<{
        thread_id: string;
        forked_from_thread_id: string;
        provider_mode: string;
        fidelity_mode: string;
        status: string;
      }>`SELECT thread_id, forked_from_thread_id, provider_mode, fidelity_mode, status FROM scient_thread_lineage ORDER BY thread_id`;
      assert.deepEqual(
        rows.map((row) => [row.thread_id, row.forked_from_thread_id]),
        [
          ["proto-a", "origin-a"],
          ["proto-b", "origin-b"],
        ],
      );
      assert.isTrue(
        rows.every(
          (row) =>
            row.provider_mode === "transcript-bootstrap" &&
            row.fidelity_mode === "transcript-bootstrap" &&
            row.status === "pending",
        ),
      );
      const queries = makeForkLineageQueries(sql);
      for (const row of rows) {
        const found = yield* queries.getForkLineageRowByThread({
          threadId: ThreadId.make(row.thread_id),
        });
        assert.ok(Option.isSome(found));
        assert.deepEqual(toForkLineageMarker(found.value), {
          originThreadId: ThreadId.make(row.forked_from_thread_id),
          baselineAssistantMessageId: null,
        });
      }
      assert.deepEqual(yield* runScientMigrations(sql), []);
      const ledger = yield* sql<{
        migration_id: number;
        applied_at: string;
        created_at: string;
      }>`SELECT migration_id, applied_at, created_at FROM scient_schema_migrations WHERE migration_id <= 2 ORDER BY migration_id`;
      assert.deepEqual(ledger, [
        {
          migration_id: 1,
          applied_at: "2026-07-01T10:00:00.000Z",
          created_at: "2026-07-01T10:00:00.000Z",
        },
        {
          migration_id: 2,
          applied_at: "2026-07-02T12:00:00.000Z",
          created_at: "2026-07-02T12:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
