import { assert, it } from "@effect/vitest";
import fs from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "./Sqlite.ts";

it.effect("enables WAL for a file-backed database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-sqlite-wal-",
      });
      const dbPath = path.join(directory, "state.sqlite");

      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode;`;
      }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)));

      assert.strictEqual(rows[0]?.journal_mode.toLowerCase(), "wal");
      if (process.platform !== "win32") {
        assert.strictEqual(fs.statSync(dbPath).mode & 0o777, 0o600);
        for (const suffix of ["-wal", "-shm"]) {
          const sidecarPath = `${dbPath}${suffix}`;
          if (fs.existsSync(sidecarPath)) {
            assert.strictEqual(fs.statSync(sidecarPath).mode & 0o777, 0o600);
          }
        }
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects an existing symlinked sidecar before opening SQLite", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-sqlite-sidecar-",
      });
      const dbPath = path.join(directory, "state.sqlite");
      const outsidePath = path.join(directory, "outside");
      fs.writeFileSync(outsidePath, "outside", { mode: 0o664 });
      fs.chmodSync(outsidePath, 0o664);
      fs.symlinkSync(outsidePath, `${dbPath}-wal`, "file");

      const exit = yield* Effect.gen(function* () {
        yield* SqlClient.SqlClient;
      }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)), Effect.exit);

      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(fs.readFileSync(outsidePath, "utf8"), "outside");
      assert.strictEqual(fs.statSync(outsidePath).mode & 0o777, 0o664);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
