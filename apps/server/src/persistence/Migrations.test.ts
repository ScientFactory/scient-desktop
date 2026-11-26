import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Logger from "effect/Logger";
import * as Console from "effect/Console";
import * as NodeUtil from "node:util";
import type { DatabaseMigrationProgress as Progress } from "@t3tools/contracts";
import {
  databaseMigrationProgress,
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import * as DatabaseMigrationProgress from "./DatabaseMigrationProgress.ts";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 59);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), '59 as "FutureMainMigration"');
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "beyond the latest known");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 58, then rechecks it without a write lock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const current = yield* Ref.make<Progress | null>(null);
      const steps: Array<Progress | null> = [];
      const loggedSteps: Array<Progress | null> = [];
      let output = "";
      const pretty = Logger.consolePretty({ mode: "tty", colors: false });
      const logger = Logger.make((options) => {
        pretty.log(options);
        if (String(options.message).startsWith(DATABASE_MIGRATION_PROGRESS_MESSAGE)) {
          steps.push(Ref.getUnsafe(current));
          loggedSteps.push(databaseMigrationProgress(output.slice(-4_000)));
        }
      });
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args) => {
              output += `${NodeUtil.format(...args)}\n`;
            },
          }),
        ),
        v2Migrations,
      );
      assert.deepStrictEqual(
        steps,
        v2Migrations.map((_, index) => ({ current: index + 1, total: v2Migrations.length })),
      );
      assert.deepStrictEqual(loggedSteps, steps);
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
        [],
      );
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);

      // query_only rejects BEGIN IMMEDIATE, which CLI startup would otherwise take on the live database.
      yield* sql`PRAGMA query_only = ON`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a known recorded migration that skips an earlier shipped step", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const [id, name] = migrationManifest.find(([id]) => id === 60)!;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "skips 59");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 58])("refuses a site-local replacement of shipped migration %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}`;
      const before = yield* history;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a partial migration request cannot bypass an incompatible recorded ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'SiteLocalMigration')`;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 58 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), '59 as "SiteLocalMigration"');
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "refuses upstream 068 occupying Scient's shipped migration identity before applying 072",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 71 });
        yield* sql`UPDATE effect_sql_migrations SET name = 'ShellStopRequestIndex'
        WHERE migration_id = 68`;
        const before = yield* history;
        const exit = yield* Effect.exit(runMigrations());
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), '68 as "ShellStopRequestIndex"');
        assert.deepStrictEqual(yield* history, before);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'index'
          AND name = 'orchestration_v2_projection_turn_items_stop_request_idx'`,
          [],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // T3 runs through its 81 and fails at 85; those are Scient's 85 and 89.
  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const current = yield* Ref.make<Progress | null>(null);
      const exit = yield* Effect.exit(
        runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 88),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // T3's peer link migrations 70-72 are Scient's 74-76.
  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 74 AND 76`;

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 74),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a database whose ledger is newer than this build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      const before = yield* history;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "beyond the latest known");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
