import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { hasPendingMigrations, runMigrations } from "./Migrations.ts";
// SCIENT-FORK:START — independent schema ledger; never consumes a T3 migration number.
import { runScientMigrations } from "../orchestration-v2/scient-fork/schema.ts";
// SCIENT-FORK:END
import {
  cleanupRetiredThreadFilesystem,
  type RetiredThreadFilesystemPaths,
} from "./RetiredThreadAttachmentCleanup.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { refreshLegacyV1Snapshot } from "./refreshLegacyV1Snapshot.ts";
// SCIENT-FORK:START — interrupted-repair recovery.
import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
// SCIENT-FORK:END
import * as ServerConfig from "../config.ts";
import * as ServerOwnership from "../serverOwnership.ts";

const WAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

export class ServerOwnsDatabaseError extends Schema.TaggedError<ServerOwnsDatabaseError>()(
  "ServerOwnsDatabaseError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `Another Scient process, usually a running server, owns ${this.stateDir}, and this CLI would change its database schema. Use the \`scient\` that matches the running server, or stop that server, then retry. The database was not changed.`;
  }
}

// CLI commands open the server's database from another process; migrating behind its owner changes the schema it runs on.
const runMigrationsAsOwner = Effect.fn("SqlitePersistence.runMigrationsAsOwner")(function* () {
  // With nothing pending, runMigrations only validates the recorded history and writes nothing.
  if (!(yield* hasPendingMigrations())) return yield* runMigrations();
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  yield* ServerOwnership.holdServerOwnershipLock(serverRuntimeStatePath).pipe(
    Effect.catchTags({
      ServerAlreadyRunningError: ({ stateDir }) =>
        Effect.fail(new ServerOwnsDatabaseError({ stateDir })),
    }),
  );
  yield* runMigrations();
}, Effect.scoped);

const makeLayerSetup = <E, R>(
  migrate: Effect.Effect<unknown, E, R>,
  // SCIENT-FORK: retired thread files are cleaned beside the database they belonged to.
  filesystemPaths?: RetiredThreadFilesystemPaths,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
      const tables = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
      if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // SCIENT-FORK:START — preserve committed scientific work across power loss.
      yield* sql`PRAGMA synchronous = FULL;`;
      // SCIENT-FORK:END
      // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
      // Per-commit fullfsync stays off.
      yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
      // Keep statement journals and sort spills off the main thread's disk path.
      // Large statements and open savepoints can increase peak memory use.
      yield* sql`PRAGMA temp_store = MEMORY;`;
      // PASSIVE checkpoints retain peak WAL size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      yield* migrate;
      // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
      // Connections cache stats; reload after deleting them.
      const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
      if (statTables.length > 0) {
        yield* sql`DELETE FROM sqlite_stat1;`;
        yield* sql`ANALYZE sqlite_schema;`;
      }
      // SCIENT-FORK:START
      yield* runScientMigrations(sql);
      // SCIENT-FORK:END
      if (filesystemPaths !== undefined) {
        yield* cleanupRetiredThreadFilesystem(filesystemPaths);
      }
    }).pipe(Effect.withSpan("Sqlite.setup")),
  );

const makeLayerFromPath = <E, R>(
  setup: (filesystemPaths: RetiredThreadFilesystemPaths) => Layer.Layer<never, E, R>,
) =>
  Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    const stateDir = path.dirname(dbPath);
    return Layer.provideMerge(
      setup({
        stateDir,
        attachmentsDir: path.join(stateDir, "attachments"),
        terminalLogsDir: path.join(stateDir, "logs", "terminals"),
        providerLogsDir: path.join(stateDir, "logs", "provider"),
      }),
      NodeSqliteClient.layer({
        filename: dbPath,
        readerWorker: true,
        // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
        checkpointWorker: true,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3code-server",
        },
      }),
    );
  }, Layer.unwrap);

export const layerFromPath = makeLayerFromPath((filesystemPaths) =>
  makeLayerSetup(runMigrations(), filesystemPaths),
);

export const layerMemory = Layer.provideMerge(
  makeLayerSetup(runMigrations()),
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

const makeLayerConfig = <E, R>(
  fromPath: (dbPath: string) => Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { dbPath } = yield* ServerConfig.ServerConfig;
      yield* initializeV2Database(dbPath);
      // SCIENT-FORK:START — repair recovery and the V1 snapshot refresh run once the schema is current.
      return Layer.provideMerge(
        Layer.effectDiscard(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // A repair that stopped after VACUUM left search pointing at renumbered rows.
            yield* DatabaseMaintenance.recoverInterruptedRepair(dbPath);
            yield* refreshLegacyV1Snapshot(dbPath).pipe(
              Effect.timed,
              Effect.tap(([duration, recoveredThreadCount]) =>
                recoveredThreadCount === 0
                  ? Effect.void
                  : Effect.logInfo("Recovered V1 conversations missing from the V2 snapshot", {
                      recoveredThreadCount,
                      durationMs: Duration.toMillis(duration),
                    }),
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  yield* sql`UPDATE scient_legacy_reconciliation_state SET last_error = ${cause.message} WHERE id = 1`;
                  yield* Effect.logWarning(cause.message);
                }),
              ),
            );
          }),
        ),
        fromPath(dbPath),
      );
      // SCIENT-FORK:END
    }),
  );

export const layerConfig = makeLayerConfig(layerFromPath);

/** For CLI commands: pending migrations run only while no server owns the Scient home. */
export const layerCliConfig = makeLayerConfig(
  makeLayerFromPath((filesystemPaths) => makeLayerSetup(runMigrationsAsOwner(), filesystemPaths)),
);
