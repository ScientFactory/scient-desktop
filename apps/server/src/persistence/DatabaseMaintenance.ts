import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { rebuildMessageSearch } from "../orchestration-v2/messageSearchIndex.ts";
// SCIENT-FORK:START — the repair keeps the server lock until it finishes.
import { holdServerOwnershipForMaintenance } from "../serverOwnership.ts";
// SCIENT-FORK:END

export class DatabaseMissingError extends Schema.TaggedError<DatabaseMissingError>()(
  "DatabaseMissingError",
  { path: Schema.String },
) {
  override get message() {
    // SCIENT-FORK:START — Scient product name in user-facing doctor errors.
    return "No existing Scient database was found in this data directory.";
    // SCIENT-FORK:END
  }
}

export class DatabaseInUseError extends Schema.TaggedError<DatabaseInUseError>()(
  "DatabaseInUseError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    // SCIENT-FORK:START — Scient product name in user-facing doctor errors.
    return "Stop the Scient server and desktop app, including any older version, before repairing the database.";
    // SCIENT-FORK:END
  }
}

export class DatabaseInspectError extends Schema.TaggedError<DatabaseInspectError>()(
  "DatabaseInspectError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not read the database. Check that this user can open it.";
  }
}

export class DatabaseCompactError extends Schema.TaggedError<DatabaseCompactError>()(
  "DatabaseCompactError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Database compaction failed. Check that no other process has the database open and enough disk space is available.";
  }
}

export class LegacyDatabaseRemoveError extends Schema.TaggedError<LegacyDatabaseRemoveError>()(
  "LegacyDatabaseRemoveError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not delete the database from before 0.1.0. Check that this user can write to the data directory.";
  }
}

export class DiskSpaceCheckError extends Schema.TaggedError<DiskSpaceCheckError>()(
  "DiskSpaceCheckError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not check free disk space.";
  }
}

export type DatabaseCompactStep = "prune-events" | "vacuum" | "rebuild-search" | "checkpoint";

export class DatabaseMaintenance extends Context.Service<
  DatabaseMaintenance,
  {
    readonly inspect: (databasePath: string) => Effect.Effect<
      {
        readonly databaseBytes: number;
        readonly reclaimableBytes: number;
        readonly incrementalVacuumEnabled: boolean;
        // SCIENT-FORK:START — Scient keeps that database and always reports null.
        /** Size of the database from before 0.1.0 still kept beside it, or null. */
        // SCIENT-FORK:END
        readonly legacyDatabaseBytes: number | null;
      },
      DatabaseMissingError | DatabaseInspectError
    >;
    /**
     * Compacts history, then VACUUMs into incremental auto_vacuum. Refuses while a server has it open.
     * Calls `onStep` as each step starts; VACUUM time grows with the whole database size.
     */
    readonly compact: (
      databasePath: string,
      onStep?: (step: DatabaseCompactStep) => Effect.Effect<void>,
    ) => Effect.Effect<
      {
        readonly beforeBytes: number;
        readonly afterBytes: number;
        readonly deletedEventCount: number;
        readonly deletedReceiptCount: number;
      },
      DatabaseMissingError | DatabaseInUseError | DatabaseCompactError
    >;
    // SCIENT-FORK:START — Scient's history import still reads that database, so removal refuses.
    /** Deletes only the pre-0.1.0 database; earlier versions still use it. */
    // SCIENT-FORK:END
    readonly removeLegacyDatabase: (
      databasePath: string,
    ) => Effect.Effect<void, DatabaseInUseError | LegacyDatabaseRemoveError>;
  }
>()("t3/persistence/DatabaseMaintenance") {}

const isDomainError = Schema.is(Schema.Union([DatabaseMissingError, DatabaseInUseError]));

const readStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  const pageSize = size[0]?.page_size ?? 0;
  return {
    databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
    reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
    incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
  };
});

/**
 * Holds an exclusive lock on the connection's database. In WAL mode this is
 * refused while any other connection has the file open, even an idle one,
 * which is how a running server or desktop app is detected.
 */
const lockExclusively = Effect.fn("DatabaseMaintenance.lockExclusively")(function* (
  databasePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA busy_timeout = 0`;
  yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
  yield* sql`BEGIN EXCLUSIVE`.pipe(
    Effect.mapError((cause) =>
      isSqlError(cause) && cause.reason._tag === "LockTimeoutError"
        ? new DatabaseInUseError({ path: databasePath, cause })
        : cause,
    ),
  );
  yield* sql`COMMIT`;
});

// SCIENT-FORK:START — see removeLegacyDatabase.
const scientOriginalDatabaseDeletable: boolean = false;
// SCIENT-FORK:END

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyPath = (databasePath: string) =>
    path.join(path.dirname(databasePath), "state.sqlite");

  const locate = Effect.fn("DatabaseMaintenance.locate")(function* (databasePath: string) {
    if (!(yield* fs.exists(databasePath))) {
      return yield* new DatabaseMissingError({ path: databasePath });
    }
  });

  const inspect = Effect.fn("DatabaseMaintenance.inspect")(
    function* (databasePath: string) {
      yield* locate(databasePath);
      const storage = yield* readStorage.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
      );
      // SCIENT-FORK:START — the original database is never offered for deletion (see
      // `removeLegacyDatabase`).
      const legacyDatabaseBytes = null;
      // SCIENT-FORK:END
      return { ...storage, legacyDatabaseBytes };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ? cause : new DatabaseInspectError({ path: databasePath, cause }),
        ),
      ),
  );

  const compact = Effect.fn("DatabaseMaintenance.compact")(
    function* (
      databasePath: string,
      onStep: (step: DatabaseCompactStep) => Effect.Effect<void> = () => Effect.void,
    ) {
      yield* locate(databasePath);
      const beforeBytes = Number((yield* fs.stat(databasePath)).size);
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* lockExclusively(databasePath);
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* onStep("prune-events");
        const summary = yield* maintenance.pruneEventStore();
        // SCIENT-FORK:START — recheck space under the lock; a marker covers a stop after VACUUM.
        // Space was checked when the repair was requested; check again now that nothing else
        // writes, before the copy that needs it.
        const storage = yield* readStorage;
        const shortfall = yield* reclaimSpaceShortfall(
          databasePath,
          storage.databaseBytes - storage.reclaimableBytes,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (shortfall !== null)
          return yield* new DatabaseCompactError({
            path: databasePath,
            cause: `Needs ${shortfall.neededBytes} free bytes; ${shortfall.freeBytes} are free.`,
          });
        // VACUUM renumbers the rows the search index points at. If the process stops after
        // VACUUM commits but before the rebuild, the marker makes the next start rebuild it.
        const marker = searchRebuildMarker(path, databasePath);
        yield* writeDurably(marker, path.dirname(marker));
        // SCIENT-FORK:END
        yield* onStep("vacuum");
        // VACUUM is required to enable incremental auto_vacuum on existing databases.
        yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`VACUUM`;
        yield* onStep("rebuild-search");
        yield* rebuildMessageSearch(sql);
        yield* onStep("checkpoint");
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        // SCIENT-FORK:START — search is rebuilt and checkpointed.
        yield* fs.remove(marker, { force: true });
        // SCIENT-FORK:END
        return summary;
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
          ),
        ),
      );
      const afterBytes = Number((yield* fs.stat(databasePath)).size);
      return {
        beforeBytes,
        afterBytes,
        deletedEventCount: result.deletedEventCount,
        deletedReceiptCount: result.deletedReceiptCount,
      };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ? cause : new DatabaseCompactError({ path: databasePath, cause }),
        ),
      ),
  );

  const removeLegacyDatabase = Effect.fn("DatabaseMaintenance.removeLegacyDatabase")(
    function* (databasePath: string) {
      const legacy = legacyPath(databasePath);
      // SCIENT-FORK:START — Scient keeps the original database. Its history import reads it,
      // an older Scient run can add conversations the current database has not copied yet, and
      // deleting it while SQLite holds it open fails on Windows.
      if (!scientOriginalDatabaseDeletable) {
        return yield* new LegacyDatabaseRemoveError({ path: legacy, cause: "kept by Scient" });
      }
      // SCIENT-FORK:END
      if (!(yield* fs.exists(legacy))) return;
      // Delete the database before WAL to preserve commits if unlink fails.
      const removeFiles = Effect.forEach(
        ["", "-wal", "-shm"],
        (suffix) => fs.remove(legacy + suffix, { force: true }),
        { discard: true },
      );
      const connection = NodeSqliteClient.layer({ filename: legacy });
      if ((yield* HostProcess.Platform) === "win32") {
        // Windows blocks unlink while any SQLite handle is open, including our own.
        yield* lockExclusively(legacy).pipe(Effect.provide(connection));
        yield* removeFiles;
      } else {
        yield* lockExclusively(legacy).pipe(
          Effect.andThen(removeFiles),
          Effect.provide(connection),
        );
      }
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "DatabaseInUseError"
            ? cause
            : new LegacyDatabaseRemoveError({ path: legacyPath(databasePath), cause }),
        ),
      ),
  );

  return DatabaseMaintenance.of({ inspect, compact, removeLegacyDatabase });
});

export const layer = Layer.effect(DatabaseMaintenance, make);

// SCIENT-FORK:START — durable repair phases: interrupted-repair recovery and restart gating.
/** Writes an empty file and flushes it, and on macOS and Linux its directory entry too, so a
 * power loss after the VACUUM it guards commits still finds it. Windows flushes only the file:
 * it cannot open a directory for flushing, so the entry's durability is the filesystem's. */
const writeDurably = Effect.fn("DatabaseMaintenance.writeDurably")(function* (
  file: string,
  directory: string,
) {
  const flushDirectory = (yield* HostProcess.Platform) !== "win32";
  yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(file, "w");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!flushDirectory) return;
      const folder = await NodeFSP.open(directory, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    },
    catch: (cause) => new DatabaseCompactError({ path: file, cause }),
  });
});

/** Present while a repair has renumbered rows but not yet rebuilt message search. */
export const searchRebuildMarker = (path: Path.Path, databasePath: string) =>
  path.join(path.dirname(databasePath), "search-rebuild-required");

/** Rebuilds message search left stale by a repair that stopped after its VACUUM.
 * Runs when the database opens, before anything reads search. */
export const recoverInterruptedRepair = Effect.fn("DatabaseMaintenance.recoverInterruptedRepair")(
  function* (databasePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const marker = searchRebuildMarker(yield* Path.Path, databasePath);
    if (!(yield* fs.exists(marker))) return;
    yield* Effect.logWarning("A database repair stopped before search was rebuilt; rebuilding it.");
    const sql = yield* SqlClient.SqlClient;
    const rebuilt = yield* rebuildMessageSearch(sql).pipe(Effect.exit);
    if (rebuilt._tag === "Success") return yield* fs.remove(marker, { force: true });
    // Stale row ids would match the wrong messages. An empty index matches none, so the app
    // can still open; the marker stays and the next start rebuilds. If even emptying it
    // fails, opening is refused rather than serving wrong results.
    yield* Effect.logError(
      "Could not rebuild message search; it stays empty until the next start",
      {
        cause: rebuilt.cause,
      },
    );
    yield* sql`INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
      VALUES ('delete-all')`;
  },
);

// Only the process that asked for a repair restarts into it. A request found by any other
// exit or start belongs to a repair that never finished, so it becomes a failure instead.
let reclaimRestartRequested = false;
export const markReclaimRestartRequested = Effect.sync(() => {
  reclaimRestartRequested = true;
});
const INTERRUPTED_RECLAIM =
  "The previous repair did not finish. Nothing was changed. You can try again.";

/** Settings' Reclaim writes the request; the failure stays for Settings until the next request. */
export const reclaimFiles = (path: Path.Path, databasePath: string) => ({
  request: path.join(path.dirname(databasePath), "reclaim-requested"),
  failure: path.join(path.dirname(databasePath), "reclaim-failed"),
});

/** A request left by a repair that never ran to completion becomes a failure Settings shows. */
export const settleInterruptedReclaim = Effect.fn("DatabaseMaintenance.settleInterruptedReclaim")(
  function* (databasePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const files = reclaimFiles(yield* Path.Path, databasePath);
    if (!(yield* fs.exists(files.request))) return;
    yield* fs.writeFileString(files.failure, INTERRUPTED_RECLAIM);
    yield* fs.remove(files.request, { force: true });
  },
);

/** Runs a repair that Settings requested. The server calls this on exit, once its database is closed.
 * Server ownership is held for the whole repair, so no other server opens the database meanwhile. */
export const runRequestedReclaim = Effect.fn("DatabaseMaintenance.runRequestedReclaim")(
  function* (databasePath: string, serverRuntimeStatePath?: string) {
    const fs = yield* FileSystem.FileSystem;
    const files = reclaimFiles(yield* Path.Path, databasePath);
    if (!(yield* fs.exists(files.request))) return;
    // Ordinary quits and updates stop the server within seconds, too soon for a repair, so only
    // the restart the request asked for runs it.
    if (!reclaimRestartRequested) return yield* settleInterruptedReclaim(databasePath);
    reclaimRestartRequested = false;
    yield* Effect.logInfo("Reclaiming database space before the restart. This can take minutes.");
    const maintenance = yield* DatabaseMaintenance;
    const repair = maintenance.compact(databasePath).pipe(
      // Worker threads and agent processes can hold the file for a moment after the server stops.
      Effect.retry({
        times: 10,
        while: (error) => error._tag === "DatabaseInUseError",
        schedule: Schedule.spaced("1 second"),
      }),
      Effect.matchEffect({
        onSuccess: (result) =>
          fs
            .remove(files.failure, { force: true })
            .pipe(Effect.andThen(Effect.logInfo("Reclaimed database space", result))),
        onFailure: (error) =>
          fs
            .writeFileString(
              files.failure,
              error._tag === "DatabaseInUseError"
                ? "Another program kept the database open. Close other Scient apps and scient commands on this machine, then try again."
                : error.message,
            )
            .pipe(
              Effect.andThen(Effect.logWarning("Database space reclamation failed", { error })),
            ),
      }),
    );
    yield* (
      serverRuntimeStatePath === undefined
        ? repair
        : holdServerOwnershipForMaintenance(serverRuntimeStatePath).pipe(
            Effect.andThen(repair),
            Effect.scoped,
            Effect.catchTags({
              ServerAlreadyRunningError: () =>
                fs.writeFileString(
                  files.failure,
                  "Scient started again before the repair could run. Try again.",
                ),
            }),
          )
    ).pipe(
      // The request ends with its attempt, so a failed repair does not rerun on later exits.
      Effect.ensuring(fs.remove(files.request, { force: true }).pipe(Effect.ignore)),
    );
  },
  Effect.catchCause((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
);
// SCIENT-FORK:END

// SQLite's search order for its temporary files (unixTempFileDir in os_unix.c).
const sqliteTempDirectory = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) === "win32") return NodeOS.tmpdir();
  const fs = yield* FileSystem.FileSystem;
  const env = yield* HostProcess.Environment;
  for (const directory of [env.SQLITE_TMPDIR, env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp"]) {
    if (directory === undefined || directory === "") continue;
    const info = yield* fs.stat(directory).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    // SQLite skips directories it cannot write to and search: osAccess(zDir, 03).
    const usable = yield* Effect.tryPromise({
      try: () => NodeFSP.access(directory, NodeFSP.constants.W_OK | NodeFSP.constants.X_OK),
      catch: (cause) => new DiskSpaceCheckError({ path: directory, cause }),
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (usable) return directory;
  }
  return ".";
});

const freeBytes = (directory: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.statfs(directory),
    catch: (cause) => new DiskSpaceCheckError({ path: directory, cause }),
  }).pipe(Effect.map((stats) => stats.bavail * stats.bsize));

/**
 * VACUUM copies the live pages to a temporary file, then writes them again to the WAL.
 * Returns the free space the repair needs when either file system has less, else null.
 */
export const reclaimSpaceShortfall = Effect.fn("DatabaseMaintenance.reclaimSpaceShortfall")(
  function* (databasePath: string, liveBytes: number) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const databaseDirectory = path.dirname(databasePath);
    const tempDirectory = yield* sqliteTempDirectory;
    const copyBytes = Math.ceil(liveBytes * 1.1);
    const [databaseFree, tempFree, databaseDevice, tempDevice] = yield* Effect.all([
      freeBytes(databaseDirectory),
      freeBytes(tempDirectory),
      fs.stat(databaseDirectory).pipe(Effect.map((info) => info.dev)),
      fs.stat(tempDirectory).pipe(Effect.map((info) => info.dev)),
    ]);
    if (databaseDevice === tempDevice) {
      return databaseFree < 2 * copyBytes
        ? { neededBytes: 2 * copyBytes, freeBytes: databaseFree }
        : null;
    }
    if (databaseFree < copyBytes) return { neededBytes: copyBytes, freeBytes: databaseFree };
    return tempFree < copyBytes ? { neededBytes: copyBytes, freeBytes: tempFree } : null;
  },
);
