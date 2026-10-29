import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { runMigrations } from "./Migrations.ts";
// SCIENT-FORK:START — independent schema ledger; never consumes a T3 migration number.
import { runScientMigrations } from "../orchestration-v2/scient-fork/schema.ts";
// SCIENT-FORK:END
import {
  cleanupRetiredThreadFilesystem,
  type RetiredThreadFilesystemPaths,
} from "./RetiredThreadAttachmentCleanup.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readerWorker?: boolean;
  readonly checkpointWorker?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
  // SCIENT-FORK:START — open options for the Overleaf state store's own SQLite file.
  /**
   * Applied while the Bun client opens the file. The Node client sets no busy
   * timeout and no journal mode on open, so it needs neither.
   */
  readonly busyTimeout?: Duration.Input;
  readonly disableWAL?: boolean;
  // SCIENT-FORK:END
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("@t3tools/shared/nodeSqliteClient"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);
// SCIENT-FORK:START — the Overleaf state store opens its own SQLite file, without V2 setup.
export { makeRuntimeSqliteLayer };
// SCIENT-FORK:END

import { initializeV2Database } from "./initializeV2Database.ts";
import { refreshLegacyV1Snapshot } from "./refreshLegacyV1Snapshot.ts";
import * as ServerConfig from "../config.ts";

const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = (filesystemPaths?: RetiredThreadFilesystemPaths) =>
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
      yield* runMigrations();
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
    }),
  );

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  const stateDir = path.dirname(dbPath);
  return Layer.provideMerge(
    layerSetup({
      stateDir,
      attachmentsDir: path.join(stateDir, "attachments"),
      terminalLogsDir: path.join(stateDir, "logs", "terminals"),
      providerLogsDir: path.join(stateDir, "logs", "provider"),
    }),
    makeRuntimeSqliteLayer({
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

export const layerMemory = Layer.provideMerge(
  layerSetup(),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return Layer.provideMerge(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
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
      layerFromPath(dbPath),
    );
  }),
);
