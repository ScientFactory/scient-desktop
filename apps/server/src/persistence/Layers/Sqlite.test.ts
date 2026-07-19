import { assert, it } from "@effect/vitest";
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
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
