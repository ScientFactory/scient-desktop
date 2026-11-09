import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /** Leave host-only cookies undefined; Electron widens any supplied domain and rejects __Host- cookies with one. */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate: number | undefined;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  // SCIENT-FORK:START — Scient Accounts: keep partitioned cookies with their stored ancestor bit.
  readonly partitionKey?: {
    readonly topLevelSite: string;
    readonly hasCrossSiteAncestor: boolean;
  };
  // SCIENT-FORK:END
}

export interface CookieReadResult {
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly undecryptable: number;
  readonly undecryptableHosts: ReadonlyArray<string>;
}

export const cookieScope = (
  host: string,
  path: string,
  secure: boolean,
): { readonly url: string; readonly domain: string | undefined } => {
  const isDomainCookie = host.startsWith(".");
  const unwrappedHost = bareHost(host);
  const authority =
    unwrappedHost.includes(":") && !(unwrappedHost.startsWith("[") && unwrappedHost.endsWith("]"))
      ? `[${unwrappedHost}]`
      : unwrappedHost;
  return {
    url: `${secure ? "https" : "http"}://${authority}${path}`,
    domain: isDomainCookie ? host : undefined,
  };
};

export const bareHost = (host: string): string => (host.startsWith(".") ? host.slice(1) : host);

// SCIENT-FORK:START — Scient Accounts: read a running browser's database from a quiet copy.
const SIDE_FILES = ["-journal", "-wal"] as const;
const QUIET_COPY_ATTEMPTS = 5;
const QUIET_COPY_RETRY = "200 millis";

/**
 * Copies the database and its change files without locking them, so the browser keeps saving.
 * The copy counts only when no file changed while it was taken; SQLite then settles it.
 */
const quietCopy = Effect.fnUntraced(
  function* (cookiePath: string, directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const suffixes = ["", ...SIDE_FILES];
    const look = Effect.forEach(suffixes, (suffix) =>
      fileSystem.stat(cookiePath + suffix).pipe(
        Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`),
        Effect.orElseSucceed(() => undefined),
      ),
    );
    for (let attempt = 0; attempt < QUIET_COPY_ATTEMPTS; attempt++) {
      if (attempt > 0) yield* Effect.sleep(QUIET_COPY_RETRY);
      const folder = path.join(directory, `copy-${attempt}`);
      yield* fileSystem.makeDirectory(folder);
      const copy = path.join(folder, path.basename(cookiePath));
      const before = yield* look;
      yield* Effect.forEach(suffixes, (suffix, index) =>
        before[index] === undefined
          ? Effect.void
          : fileSystem.copyFile(cookiePath + suffix, copy + suffix),
      );
      if ((yield* look).join("|") === before.join("|")) return copy;
    }
    return undefined;
  },
  Effect.orElseSucceed(() => undefined),
);
// SCIENT-FORK:END

/** Copy before reading to avoid live WAL writes and never open the source browser database for writing. */
export const snapshotCookieDatabase = Effect.fn("CookieDatabase.snapshotCookieDatabase")(function* (
  cookiePath: string,
  tempPrefix = "t3code-cookie-import-",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: tempPrefix });
  const target = path.join(directory, path.basename(cookiePath));
  // SCIENT-FORK:START — Scient Accounts: read a running browser's database from a quiet copy.
  const copy = yield* quietCopy(cookiePath, directory);
  if (copy !== undefined) {
    const settled = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${target}`;
      return true;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: copy })),
      Effect.orElseSucceed(() => false),
    );
    if (settled) return target;
  }
  // SCIENT-FORK:END
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`VACUUM INTO ${target}`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: cookiePath, readonly: true })));
  return target;
});
