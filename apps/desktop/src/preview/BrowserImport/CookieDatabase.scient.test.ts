import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { snapshotCookieDatabase } from "./CookieDatabase.ts";

describe("snapshotCookieDatabase for Scient Accounts", () => {
  it.effect("reads what a running browser saved, while it holds the database locked", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-cookie-held-",
      });
      const source = path.join(directory, "Cookies");
      const snapshot = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE cookies(name TEXT NOT NULL)`;
        yield* sql`INSERT INTO cookies(name) VALUES (${"saved"})`;
        // The browser is mid-save: it holds the lock, and its change isn't saved yet.
        yield* sql`BEGIN EXCLUSIVE`;
        yield* sql`INSERT INTO cookies(name) VALUES (${"unsaved"})`;
        const taken = yield* snapshotCookieDatabase(source);
        yield* sql`ROLLBACK`;
        return taken;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly name: string }>`SELECT name FROM cookies`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshot, readonly: true })));
      expect(rows).toEqual([{ name: "saved" }]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
