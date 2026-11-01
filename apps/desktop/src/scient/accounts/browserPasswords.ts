import type { BrowserImportSourceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { snapshotCookieDatabase } from "../../preview/BrowserImport/CookieDatabase.ts";
import { decryptChromiumValue } from "../../preview/BrowserImport/ChromiumCookies.ts";
import {
  ChromiumKeyError,
  readWindowsKey,
  resolveChromiumKeys,
  type ChromiumKeyMaterial,
} from "../../preview/BrowserImport/ChromiumKeys.ts";
import {
  BROWSER_IMPORT_SOURCES,
  listSourceProfiles,
  sourcePathContext,
} from "../../preview/BrowserImport/Sources.ts";
import { DesktopAccountsError } from "./errors.ts";

export class BrowserPasswordsUnsupported extends Schema.TaggedError<BrowserPasswordsUnsupported>()(
  "BrowserPasswordsUnsupported",
  {},
) {
  override get message() {
    return "Not supported on this system";
  }
}
const LoginRow = Schema.Struct({
  origin_url: Schema.String,
  signon_realm: Schema.String,
  username_value: Schema.String,
  password_value: Schema.Uint8Array,
  blacklisted_by_user: Schema.Number,
});
const isChromiumKeyError = Schema.is(ChromiumKeyError);
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(LoginRow));
const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;

export const passwordsToCsv = (
  rows: ReadonlyArray<typeof LoginRow.Type>,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
) => {
  const lines = ["name,url,username,password"];
  let skipped = 0;
  for (const row of rows) {
    const address = row.origin_url || row.signon_realm;
    if (
      row.blacklisted_by_user ||
      !row.password_value.length ||
      address.startsWith("android://") ||
      row.signon_realm.startsWith("android://")
    ) {
      skipped++;
      continue;
    }
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      skipped++;
      continue;
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      skipped++;
      continue;
    }
    const prefix = Buffer.from(row.password_value.subarray(0, 3)).toString("latin1");
    // Password records have no cookie domain-binding prefix; unknown encryption versions fail closed.
    const password = ["v10", "v11"].includes(prefix)
      ? decryptChromiumValue(row.password_value, keys, "", 23, platform)
      : null;
    if (!password) {
      skipped++;
      continue;
    }
    lines.push([url.hostname, url.href, row.username_value, password].map(csvCell).join(","));
  }
  return { content: lines.join("\n"), skipped };
};

export const readPasswordDatabase = Effect.fn("DesktopAccounts.readPasswordDatabase")(
  function* (database: string, keys: ChromiumKeyMaterial, platform: NodeJS.Platform) {
    const snapshot = yield* snapshotCookieDatabase(database, "scient-password-import-");
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`select origin_url, signon_realm, username_value, password_value, blacklisted_by_user from logins`.pipe(
        Effect.flatMap(decodeRows),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshot, readonly: true })));
    return passwordsToCsv(rows, keys, platform);
  },
  Effect.mapError(() => new DesktopAccountsError({})),
);

const browserPasswordSource = Effect.fn("DesktopAccounts.browserPasswordSource")(function* (
  sourceId: BrowserImportSourceId,
  directory: string,
) {
  const context = yield* sourcePathContext;
  const definition = BROWSER_IMPORT_SOURCES.find((item) => item.id === sourceId);
  if (
    !definition ||
    definition.engine !== "chromium" ||
    !definition.platforms.includes(context.platform)
  )
    return yield* new DesktopAccountsError({});
  const profiles = yield* listSourceProfiles(definition, context, false);
  const root = definition.userDataDirectory(context);
  if (!root || !profiles.some((profile) => profile.directory === directory))
    return yield* new DesktopAccountsError({});
  return { context, definition, root, database: context.path.join(root, directory, "Login Data") };
});

export const readBrowserPasswords = Effect.fn("DesktopAccounts.readBrowserPasswords")(
  function* (sourceId: BrowserImportSourceId, directory: string) {
    const { context, definition, root, database } = yield* browserPasswordSource(
      sourceId,
      directory,
    );
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(database))) return { content: "name,url,username,password", skipped: 0 };
    const keys: ChromiumKeyMaterial = yield* context.platform === "win32"
      ? readWindowsKey(context.path.join(root, "Local State")).pipe(
          Effect.map((gcmV10) => ({ gcmV10 })),
        )
      : resolveChromiumKeys({
          platform: context.platform,
          keychainService: definition.keychainService,
          keychainAccount: definition.keychainAccount,
          linuxSecretApplication: definition.linuxSecretApplication,
        });
    return yield* readPasswordDatabase(database, keys, context.platform).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const key of [keys.cbcV10, keys.cbcV11, keys.cbcEmpty, keys.gcmV10]) key?.fill(0);
        }),
      ),
    );
  },
  Effect.scoped,
  Effect.mapError((error) =>
    isChromiumKeyError(error) && error.reason === "unsupportedPlatform"
      ? new BrowserPasswordsUnsupported({})
      : new DesktopAccountsError({}),
  ),
);

export const countBrowserPasswords = Effect.fn("DesktopAccounts.countBrowserPasswords")(
  function* (database: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(database))) return undefined;
    const snapshot = yield* snapshotCookieDatabase(database, "scient-password-count-");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        count: number;
      }>`select count(*) as count from logins where blacklisted_by_user = 0 and length(password_value) > 0 and signon_realm not like 'android://%' and origin_url not like 'android://%'`;
      return rows[0]?.count;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshot, readonly: true })));
  },
  Effect.scoped,
  Effect.orElseSucceed(() => undefined),
);
