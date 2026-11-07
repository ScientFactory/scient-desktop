import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { readChromiumCookieDatabase } from "./ChromiumCookies.ts";

describe("partitioned Chrome cookies", () => {
  it.effect("keep their stored ancestor bit, and are skipped and counted without it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-chips-" });
      const filename = `${directory}/Cookies`;
      const insert = (sql: SqlClient.SqlClient, ancestor: number) =>
        sql`insert into cookies values ('.partitioned.example', 'chip', 'synthetic', ${new Uint8Array()},
          '/', 0, 1, 0, 0, 'https://top.example', ${ancestor})`;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value integer not null)`;
        yield* sql`insert into meta values ('version', 23)`;
        yield* sql`create table cookies (
          host_key text not null, name text not null, value text not null,
          encrypted_value blob not null, path text not null, expires_utc integer not null,
          is_secure integer not null, is_httponly integer not null, samesite integer not null,
          top_frame_site_key text not null, has_cross_site_ancestor integer not null
        )`;
        yield* insert(sql, 1);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const read = yield* readChromiumCookieDatabase(filename, {}, "darwin");
      expect(read.undecryptable).toBe(0);
      expect(read.cookies.map((cookie) => cookie.partitionKey)).toEqual([
        { topLevelSite: "https://top.example", hasCrossSiteAncestor: true },
      ]);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`alter table cookies drop column has_cross_site_ancestor`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      const withoutBit = yield* readChromiumCookieDatabase(filename, {}, "darwin");
      expect(withoutBit.cookies).toEqual([]);
      expect(withoutBit.undecryptable).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
