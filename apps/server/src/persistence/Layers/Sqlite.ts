import fs from "node:fs";

import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";
import { ensurePrivateFileSync, repairPrivateFileSync } from "../../privatePathPermissions.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    return clientModule.layer(config);
  }).pipe(Layer.unwrap);

const makeSetup = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journalModeRows = yield* sql<{ readonly journal_mode: string }>`
        PRAGMA journal_mode = WAL;
      `;
      const journalMode = journalModeRows[0]?.journal_mode;
      // In-memory SQLite correctly reports `memory`; only file-backed databases
      // are expected to enter WAL mode.
      if (filename !== ":memory:" && journalMode?.toLowerCase() !== "wal") {
        yield* Effect.logWarning("SQLite WAL journal mode could not be enabled", {
          resultingJournalMode: journalMode ?? "unknown",
        });
      }
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* runMigrations();
      if (filename !== ":memory:") {
        yield* Effect.sync(() => {
          ensurePrivateFileSync(filename);
          for (const suffix of ["-wal", "-shm"]) {
            const sidecarPath = `${filename}${suffix}`;
            if (fs.existsSync(sidecarPath)) repairPrivateFileSync(sidecarPath);
          }
        });
      }
    }),
  );

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
    yield* Effect.sync(() => ensurePrivateFileSync(dbPath));

    return Layer.provideMerge(makeSetup(dbPath), makeRuntimeSqliteLayer({ filename: dbPath }));
  }).pipe(Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  makeSetup(":memory:"),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
