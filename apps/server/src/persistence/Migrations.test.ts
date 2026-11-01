import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

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

  it.effect("upgrades a database at exactly 58", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 58 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
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
