// @effect-diagnostics nodeBuiltinImport:off - Encrypts fixtures with the same OSCrypt primitive
// the module under test decrypts.
import * as NodeCrypto from "node:crypto";
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

const encryptWindowsV10 = (value: string, key: Buffer): Uint8Array => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, encrypted, cipher.getAuthTag()]);
};

describe("a Windows jar Chrome partly app-bound", () => {
  it.effect("reads its v10 rows and counts each skipped row once, by cause", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-v20-" });
      const filename = `${directory}/Cookies`;
      const key = NodeCrypto.randomBytes(32);
      const v20 = Buffer.concat([Buffer.from("v20"), NodeCrypto.randomBytes(48)]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value integer not null)`;
        yield* sql`insert into meta values ('version', 23)`;
        yield* sql`create table cookies (
          host_key text not null, name text not null, value text not null,
          encrypted_value blob not null, path text not null, expires_utc integer not null,
          is_secure integer not null, is_httponly integer not null, samesite integer not null,
          top_frame_site_key text not null, has_cross_site_ancestor integer
        )`;
        const row = (host: string, encrypted: Uint8Array, top = "", ancestor: number | null = 0) =>
          sql`insert into cookies values (${host}, 'session', '', ${encrypted}, '/', 0, 1, 1, 1,
            ${top}, ${ancestor})`;
        yield* row(".kept.example", encryptWindowsV10("kept", key));
        yield* row(".google.com", v20);
        yield* row(".bound.example", v20);
        yield* row(".corrupt.example", encryptWindowsV10("lost", NodeCrypto.randomBytes(32)));
        // Also app-bound, but its missing ancestor bit already keeps it out.
        yield* row(".chips.example", v20, "https://top.example", null);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const read = yield* readChromiumCookieDatabase(filename, { gcmV10: key }, "win32");
      expect(read.cookies.map((cookie) => cookie.value)).toEqual(["kept"]);
      expect(read.undecryptable).toBe(4);
      expect(read.skippedByReason).toEqual({
        appBoundEncryption: 2,
        decryptFailed: 1,
        partitionUnsupported: 1,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
