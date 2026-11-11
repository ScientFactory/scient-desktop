import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as ServerOwnership from "../serverOwnership.ts";

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    // SCIENT-FORK:START — Scient keeps the original database: it is never offered, and its
    // removal refuses without touching it.
    it.effect("keeps the original database and never offers to delete it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-" });
        const dbPath = path.join(userdata, "statev2.sqlite");
        const legacy = path.join(userdata, "state.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE v1_data (value TEXT)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: legacy })));

        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
        const refused = yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
        assert.equal(refused._tag, "LegacyDatabaseRemoveError");
        assert.isTrue(yield* fs.exists(legacy));
        assert.isTrue(yield* fs.exists(dbPath));
      }).pipe(Effect.scoped),
    );
    // SCIENT-FORK:END

    it.effect("runs a repair requested from Settings once and keeps its failure for Settings", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-requested-reclaim-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        const files = DatabaseMaintenance.reclaimFiles(path, dbPath);
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        const autoVacuum = Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`,
        ).pipe(
          Effect.map((rows) => rows[0]?.auto_vacuum),
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        // Every server exit runs this; without a request it must leave the database alone.
        yield* DatabaseMaintenance.runRequestedReclaim(dbPath);
        assert.equal(yield* autoVacuum, 0);

        // A request no restart asked for (its repair was interrupted, or an ordinary quit
        // found it) must not start a repair the quit would kill; it becomes a failure.
        yield* fs.writeFileString(files.request, "");
        yield* DatabaseMaintenance.runRequestedReclaim(dbPath);
        assert.isFalse(yield* fs.exists(files.request));
        assert.include(yield* fs.readFileString(files.failure), "did not finish");
        assert.equal(yield* autoVacuum, 0);

        yield* fs.writeFileString(files.request, "");
        yield* fs.writeFileString(files.failure, "an earlier failure");
        yield* DatabaseMaintenance.markReclaimRestartRequested;
        yield* DatabaseMaintenance.runRequestedReclaim(dbPath);
        assert.isFalse(yield* fs.exists(files.request));
        assert.isFalse(yield* fs.exists(files.failure));
        assert.equal(yield* autoVacuum, 2);
        assert.isFalse(
          yield* fs.exists(DatabaseMaintenance.searchRebuildMarker(path, dbPath)),
          "a finished repair leaves no search rebuild pending",
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

        const brokenPath = path.join(baseDir, "broken", "statev2.sqlite");
        const broken = DatabaseMaintenance.reclaimFiles(path, brokenPath);
        yield* fs.makeDirectory(path.dirname(brokenPath));
        yield* fs.writeFileString(brokenPath, "not a database");
        yield* fs.writeFileString(broken.request, "");
        yield* DatabaseMaintenance.markReclaimRestartRequested;
        yield* DatabaseMaintenance.runRequestedReclaim(brokenPath);
        assert.isFalse(
          yield* fs.exists(broken.request),
          "a failed repair must not rerun on every exit",
        );
        assert.equal(
          yield* fs.readFileString(broken.failure),
          new DatabaseMaintenance.DatabaseCompactError({ path: brokenPath, cause: null }).message,
        );
      }).pipe(Effect.scoped),
    );

    it.effect("rebuilds message search when a repair stopped after its VACUUM", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-marker-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        const searchRows = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_v2_message_search
            WHERE orchestration_v2_message_search MATCH 'needle'`;
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            ) VALUES ('message-1', 'thread-1', NULL, NULL, 'user', 0,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{"text":"needle"}')`;
          // The state a repair leaves if it stops between VACUUM and the rebuild.
          yield* sql`INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
            VALUES ('delete-all')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const marker = DatabaseMaintenance.searchRebuildMarker(path, dbPath);
        yield* fs.writeFileString(marker, "");
        // Opening the database through the server path recovers it before anything reads search.
        const found = yield* Effect.gen(function* () {
          yield* DatabaseMaintenance.recoverInterruptedRepair(dbPath);
          return yield* searchRows;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(found[0]!.count, 1);
        assert.isFalse(yield* fs.exists(marker));
      }).pipe(Effect.scoped),
    );

    it.effect("does not repair a database another server has started on meanwhile", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reclaim-owner-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        const statePath = path.join(baseDir, "userdata", "server-runtime.json");
        const files = DatabaseMaintenance.reclaimFiles(path, dbPath);
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* fs.writeFileString(files.request, "");
        yield* DatabaseMaintenance.markReclaimRestartRequested;
        yield* Effect.gen(function* () {
          // A successor server owns the home before the repair starts.
          yield* ServerOwnership.holdServerOwnershipForMaintenance(statePath);
          yield* DatabaseMaintenance.runRequestedReclaim(dbPath, statePath);
        }).pipe(Effect.scoped);
        assert.include(yield* fs.readFileString(files.failure), "started again");
        assert.isFalse(yield* fs.exists(files.request));
        const mode = yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`,
        ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        assert.equal(mode[0]?.auto_vacuum, 0);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses a repair whose copies would not fit on disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-reclaim-space-" }),
          "statev2.sqlite",
        );
        assert.isNull(yield* DatabaseMaintenance.reclaimSpaceShortfall(dbPath, 1024));
        const huge = 2 ** 60;
        const shortfall = yield* DatabaseMaintenance.reclaimSpaceShortfall(dbPath, huge);
        assert.isAtLeast(shortfall?.neededBytes ?? 0, huge);
        assert.isBelow(shortfall?.freeBytes ?? Infinity, huge);
      }).pipe(Effect.scoped),
    );

    it.effect("compacts an existing database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        // Opening the database migrates it.
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            )
            VALUES (
              'message-1', 'thread-1', NULL, NULL, 'user', 0,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{"text":"needle"}'
            )
          `;
          // An index that drifted from its rows, as a renumbering VACUUM would leave it.
          yield* sql`
            INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
            VALUES ('delete-all')
          `;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (
            thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
          ) VALUES ('imported', '2026-10-17', '2026-10-17', '2026-10-17', 0)`;
          yield* sql`WITH RECURSIVE history(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 51
          ) INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
          ) SELECT 'legacy-' || n, 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy' FROM history`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          return yield* maintenance.compact(dbPath).pipe(Effect.flip);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const clock = yield* Clock.Clock;
        const pauses: number[] = [];
        let activeNanos = 0n;
        const result = yield* maintenance.compact(dbPath).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            // Exceed the background budget whenever the compactor checks elapsed time.
            monotonicTimeNanos: Effect.sync(() => (activeNanos += 30_000_000n)),
            sleep: (duration) =>
              Effect.sync(() => {
                pauses.push(Duration.toMillis(duration));
              }),
          }),
        );
        assert.deepEqual(pauses, [], "offline doctor must not throttle compaction");
        assert.equal(result.deletedReceiptCount, 51);
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
          assert.deepEqual(
            yield* sql`
              SELECT messages.message_id AS "messageId"
              FROM orchestration_v2_message_search AS search
              INNER JOIN orchestration_v2_projection_messages AS messages
                ON messages.rowid = search.rowid
              WHERE orchestration_v2_message_search MATCH '"needle"'
            `,
            [{ messageId: "message-1" }],
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );
  },
);
