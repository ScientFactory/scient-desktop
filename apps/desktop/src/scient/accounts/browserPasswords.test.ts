// @effect-diagnostics nodeBuiltinImport:off -- Synthetic encryption fixtures never read native credentials.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import { countBrowserPasswords, passwordsToCsv, readPasswordDatabase } from "./browserPasswords.ts";

const key = NodeCrypto.pbkdf2Sync("synthetic safe storage", "saltysalt", 1003, 16, "sha1");
const secret = 'synthetic-password,"\nvalue';
const encrypt = (value: string) => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
};
const login = {
  origin_url: "https://login.example.test/path",
  signon_realm: "https://login.example.test/",
  username_value: "synthetic-user",
  password_value: encrypt(secret),
  blacklisted_by_user: 0,
};

it.effect(
  "reads a synthetic WAL Login Data snapshot, maps rows and removes all temporary copies",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = `${directory}/Login Data`;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`pragma journal_mode = WAL`;
        yield* sql`create table logins (origin_url text, signon_realm text, username_value text, password_value blob, blacklisted_by_user integer)`;
        const rows = [
          login,
          { ...login, origin_url: "", signon_realm: "https://realm.example.test/" },
          { ...login, blacklisted_by_user: 1 },
          { ...login, password_value: Buffer.alloc(0) },
          { ...login, origin_url: "android://hash@package" },
          { ...login, signon_realm: "android://hash@package" },
          { ...login, password_value: Buffer.from("v10invalid") },
          { ...login, password_value: Buffer.from("v20unsupported") },
          { ...login, origin_url: "not a URL" },
          { ...login, origin_url: "file:///tmp/example" },
          { ...login, password_value: encrypt("") },
        ];
        for (const row of rows) yield* sql`insert into logins ${sql.insert(row)}`;
        expect(yield* countBrowserPasswords(database)).toBe(7);
        const logs = vi.fn();
        const result = yield* readPasswordDatabase(database, { cbcV10: key }, "darwin").pipe(
          Effect.scoped,
          Effect.provide(Logger.layer([Logger.make(logs)])),
        );
        expect(result.skipped).toBe(9);
        expect(result.content).toContain(
          '"login.example.test","https://login.example.test/path","synthetic-user","synthetic-password,""\nvalue"',
        );
        expect(result.content).toContain('"realm.example.test"');
        expect(JSON.stringify(logs.mock.calls)).not.toContain("synthetic-password");
        const entries = yield* fs.readDirectory(directory + "/..");
        expect(
          entries.filter(
            (entry) =>
              entry.startsWith("scient-password-import-") ||
              entry.startsWith("scient-password-count-"),
          ),
        ).toEqual([]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("sanitizes database failures and cleans snapshots without logging plaintext", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const database = `${directory}/Login Data`;
    yield* fs.writeFileString(database, secret);
    const logs = vi.fn();
    const error = yield* readPasswordDatabase(database, { cbcV10: key }, "darwin").pipe(
      Effect.scoped,
      Effect.flip,
      Effect.provide(Logger.layer([Logger.make(logs)])),
    );
    expect(error.message).toBe("Scient Accounts desktop operation failed.");
    expect(JSON.stringify(error)).not.toContain("synthetic-password");
    expect(JSON.stringify(logs.mock.calls)).not.toContain("synthetic-password");
    expect(
      (yield* fs.readDirectory(directory + "/..")).filter((entry) =>
        entry.startsWith("scient-password-import-"),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("uses Linux v11 and Windows v10 keys but skips app-bound records", () => {
  const linux = {
    ...login,
    password_value: Buffer.concat([Buffer.from("v11"), encrypt(secret).subarray(3)]),
  };
  expect(passwordsToCsv([linux], { cbcV11: key }, "linux").skipped).toBe(0);
  const gcmKey = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 3);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", gcmKey, nonce);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  const windows = {
    ...login,
    password_value: Buffer.concat([Buffer.from("v10"), nonce, encrypted, cipher.getAuthTag()]),
  };
  expect(
    passwordsToCsv(
      [windows, { ...login, password_value: Buffer.from("v20app-bound") }],
      { gcmV10: gcmKey },
      "win32",
    ).skipped,
  ).toBe(1);
});
