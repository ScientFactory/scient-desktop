// @effect-diagnostics globalJsonInEffect:off - stored JSON is this object's own, written from decoded input.
import type {
  CreateShareRequest,
  PatchShareRequest,
  ShareAccess,
  ShareCard,
  ShareRecord,
  ShareVersion,
} from "@scientfactory/scient-cloud/api";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SqlClient from "effect/sql/SqlClient";

import { failWith, type CloudError } from "./CloudError.ts";
import type { RunSql } from "./UserStore.ts";

/** One shared link, kept in its own Durable Object (SQLite). */

const MAX_REPORTS = 100;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const parseIso = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
const seg = encodeURIComponent;

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS share (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      source TEXT NOT NULL,
      encrypted INTEGER NOT NULL,
      access TEXT NOT NULL,
      expires_at INTEGER,
      indexable INTEGER NOT NULL,
      card TEXT,
      created_at INTEGER NOT NULL,
      current_version INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, published_at INTEGER)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS objects (
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      object_key TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (version, name)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
});

interface ShareRow {
  readonly id: string;
  readonly owner: string;
  readonly source: string;
  readonly encrypted: number;
  readonly access: string;
  readonly expires_at: number | null;
  readonly indexable: number;
  readonly card: string | null;
  readonly created_at: number;
  readonly current_version: number | null;
  readonly revoked: number;
  readonly revision: number;
}

const notFound = () => failWith("not_found", "This shared link does not exist or has ended.");

const liveRow = Effect.fn("ShareStore.liveRow")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<ShareRow>`SELECT * FROM share`;
  if (!row || row.revoked || (row.expires_at !== null && row.expires_at <= now)) {
    return yield* notFound();
  }
  return row;
});

const ownedRow = Effect.fn("ShareStore.ownedRow")(function* (owner: string, now: number) {
  const row = yield* liveRow(now);
  if (row.owner !== owner) return yield* notFound();
  return row;
});

const publishedVersions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly version: number; readonly published_at: number }>`
    SELECT version, published_at FROM versions WHERE published_at IS NOT NULL ORDER BY version
  `;
  return rows.map((row): ShareVersion => ({
    version: row.version as ShareVersion["version"],
    publishedAt: iso(row.published_at) as ShareVersion["publishedAt"],
  }));
});

const toRecord = (row: ShareRow, versions: ReadonlyArray<ShareVersion>): ShareRecord =>
  ({
    id: row.id,
    source: JSON.parse(row.source),
    encrypted: row.encrypted === 1,
    access: JSON.parse(row.access),
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    indexable: row.indexable === 1,
    ...(row.card === null ? {} : { card: JSON.parse(row.card) }),
    createdAt: iso(row.created_at),
    currentVersion: row.current_version,
    versions,
  }) as ShareRecord;

/** Deletes every object; the caller removes the returned keys and releases the owner's bytes. */
const purge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{ readonly object_key: string }>`SELECT object_key FROM objects`;
  yield* sql`DELETE FROM objects`;
  yield* sql`DELETE FROM versions`;
  yield* sql`UPDATE share SET revoked = 1, current_version = NULL`;
  return objects.map((object) => object.object_key);
});

export interface AccessCheck {
  readonly owner: string;
  readonly access: ShareAccess;
}

export type ShareApi = ReturnType<typeof makeShareApi>;

/** `scheduleExpiry` sets (or clears with null) the object's alarm. */
export const makeShareApi = (
  shareId: string,
  run: RunSql,
  scheduleExpiry: (at: number | null) => Effect.Effect<void>,
) => {
  const prefix = `s/${seg(shareId)}`;
  return {
    create: (input: {
      readonly owner: string;
      readonly request: CreateShareRequest;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const existing = yield* sql<{ readonly id: string }>`SELECT id FROM share`;
          if (existing.length > 0) return yield* failWith("invalid_request", "Share id in use.");
          const { request } = input;
          const expiresAt = request.expiresAt ? parseIso(request.expiresAt) : null;
          if (expiresAt !== null && expiresAt <= input.now) {
            return yield* failWith("invalid_request", "The expiry is in the past.");
          }
          const card = !request.encrypted && request.card ? JSON.stringify(request.card) : null;
          yield* sql`
            INSERT INTO share (id, owner, source, encrypted, access, expires_at, indexable, card,
              created_at, current_version)
            VALUES (${shareId}, ${input.owner}, ${JSON.stringify(request.source)},
              ${request.encrypted ? 1 : 0}, ${JSON.stringify(request.access)}, ${expiresAt},
              ${request.indexable ? 1 : 0}, ${card}, ${input.now}, NULL)
          `;
          yield* scheduleExpiry(expiresAt);
          const [row] = yield* sql<ShareRow>`SELECT * FROM share`;
          return toRecord(row!, []);
        }),
      ),

    record: (owner: string, now: number) =>
      run(
        Effect.gen(function* () {
          const row = yield* ownedRow(owner, now);
          return toRecord(row, yield* publishedVersions);
        }),
      ),

    patch: (input: {
      readonly owner: string;
      readonly patch: PatchShareRequest;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* ownedRow(input.owner, input.now);
          const { patch } = input;
          if (patch.access !== undefined) {
            yield* sql`UPDATE share SET access = ${JSON.stringify(patch.access)}`;
          }
          if (patch.indexable !== undefined) {
            yield* sql`UPDATE share SET indexable = ${patch.indexable ? 1 : 0}`;
          }
          if (patch.expiresAt !== undefined) {
            const expiresAt = patch.expiresAt === null ? null : parseIso(patch.expiresAt);
            if (expiresAt !== null && expiresAt <= input.now) {
              return yield* failWith("invalid_request", "The expiry is in the past.");
            }
            yield* sql`UPDATE share SET expires_at = ${expiresAt}`;
            yield* scheduleExpiry(expiresAt);
          }
          const [row] = yield* sql<ShareRow>`SELECT * FROM share`;
          return toRecord(row!, yield* publishedVersions);
        }),
      ),

    /** Published versions are frozen; the next version is the only open draft. */
    beginPut: (input: {
      readonly owner: string;
      readonly version: number;
      readonly name: string;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* ownedRow(input.owner, input.now);
          const [latest] = yield* sql<{ readonly v: number | null }>`
            SELECT MAX(version) AS v FROM versions WHERE published_at IS NOT NULL
          `;
          const draft = Number(latest?.v ?? 0) + 1;
          if (input.version !== draft) {
            return yield* failWith(
              "invalid_request",
              `Only version ${draft} of this link can be written now.`,
            );
          }
          const [replaced] = yield* sql<{ readonly bytes: number }>`
            SELECT bytes FROM objects WHERE version = ${input.version} AND name = ${input.name}
          `;
          const nonce = Base64Url.encode(crypto.getRandomValues(new Uint8Array(12)));
          return {
            objectKey: `${prefix}/v/${input.version}/${input.name}/${nonce}`,
            replacing: replaced?.bytes ?? 0,
          };
        }),
      ),

    /**
     * Returns the replaced key to delete (if any) and the bytes the share now stores, numbered
     * by `revision` so the owner's usage can apply totals in order.
     */
    commitPut: (input: {
      readonly owner: string;
      readonly version: number;
      readonly name: string;
      readonly objectKey: string;
      readonly bytes: number;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* ownedRow(input.owner, input.now);
          const [published] = yield* sql<{ readonly published_at: number | null }>`
            SELECT published_at FROM versions WHERE version = ${input.version}
          `;
          if (published?.published_at) {
            return yield* failWith("invalid_request", "That version is already published.");
          }
          const [replaced] = yield* sql<{ readonly object_key: string; readonly bytes: number }>`
            SELECT object_key, bytes FROM objects
            WHERE version = ${input.version} AND name = ${input.name}
          `;
          yield* sql`
            INSERT INTO versions (version, published_at) VALUES (${input.version}, NULL)
            ON CONFLICT DO NOTHING
          `;
          yield* sql`
            INSERT INTO objects (version, name, object_key, bytes)
            VALUES (${input.version}, ${input.name}, ${input.objectKey}, ${input.bytes})
            ON CONFLICT (version, name) DO UPDATE SET
              object_key = excluded.object_key, bytes = excluded.bytes
          `;
          const [state] = yield* sql<{ readonly revision: number; readonly total: number }>`
            UPDATE share SET revision = revision + 1
            RETURNING revision, (SELECT COALESCE(SUM(bytes), 0) FROM objects) AS total
          `;
          return {
            replacedKey: replaced?.object_key ?? null,
            totalBytes: Number(state?.total ?? 0),
            revision: Number(state?.revision ?? 0),
          };
        }),
      ),

    publish: (input: { readonly owner: string; readonly version: number; readonly now: number }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* ownedRow(input.owner, input.now);
          const [snapshot] = yield* sql<{ readonly name: string }>`
            SELECT name FROM objects WHERE version = ${input.version} AND name = 'snapshot'
          `;
          if (!snapshot) {
            return yield* failWith("invalid_request", "Upload the snapshot before publishing.");
          }
          const [state] = yield* sql<{ readonly published_at: number | null }>`
            SELECT published_at FROM versions WHERE version = ${input.version}
          `;
          if (!state?.published_at) {
            yield* sql`
              UPDATE versions SET published_at = ${input.now} WHERE version = ${input.version}
            `;
          }
          yield* sql`UPDATE share SET current_version = ${input.version}`;
          const [row] = yield* sql<ShareRow>`SELECT * FROM share`;
          return toRecord(row!, yield* publishedVersions);
        }),
      ),

    revoke: (owner: string, now: number) =>
      run(
        Effect.gen(function* () {
          yield* ownedRow(owner, now);
          yield* scheduleExpiry(null);
          return yield* purge;
        }),
      ),

    /** The alarm: ends an expired link. Returns the owner and keys, or null if nothing to do. */
    expire: (now: number) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<ShareRow>`SELECT * FROM share`;
          if (!row || row.revoked) return null;
          if (row.expires_at === null || row.expires_at > now) {
            yield* scheduleExpiry(row.expires_at);
            return null;
          }
          return { owner: row.owner, shareId, keys: yield* purge };
        }),
      ),

    /** What the public page shell needs; private shares never expose their card. */
    page: (now: number) =>
      run(
        Effect.gen(function* () {
          const row = yield* liveRow(now);
          const access = JSON.parse(row.access) as ShareAccess;
          const card =
            row.encrypted === 0 && access.mode === "link" && row.card !== null
              ? (JSON.parse(row.card) as ShareCard)
              : null;
          return {
            indexable: row.indexable === 1 && access.mode === "link",
            card,
            published: row.current_version !== null,
          };
        }),
      ),

    publicInfo: (now: number) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const row = yield* liveRow(now);
          if (row.current_version === null) return yield* notFound();
          const objects = yield* sql<{ readonly name: string; readonly bytes: number }>`
            SELECT name, bytes FROM objects WHERE version = ${row.current_version} ORDER BY name
          `;
          return {
            check: { owner: row.owner, access: JSON.parse(row.access) } as AccessCheck,
            info: {
              encrypted: row.encrypted === 1,
              currentVersion: row.current_version,
              versions: yield* publishedVersions,
              objects: objects.map((object) => ({ name: object.name, bytes: object.bytes })),
            },
          };
        }),
      ),

    publicObject: (input: {
      readonly version: number;
      readonly name: string;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const row = yield* liveRow(input.now);
          const [object] = yield* sql<{ readonly object_key: string; readonly bytes: number }>`
            SELECT objects.object_key, objects.bytes FROM objects
            JOIN versions ON versions.version = objects.version
            WHERE objects.version = ${input.version} AND objects.name = ${input.name}
              AND versions.published_at IS NOT NULL
          `;
          if (!object) return yield* notFound();
          return {
            check: { owner: row.owner, access: JSON.parse(row.access) } as AccessCheck,
            encrypted: row.encrypted === 1,
            objectKey: object.object_key,
            bytes: object.bytes,
          };
        }),
      ),

    report: (input: { readonly reason: string; readonly now: number }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* liveRow(input.now);
          const [count] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM reports`;
          if (Number(count?.n ?? 0) >= MAX_REPORTS) return;
          yield* sql`
            INSERT INTO reports (reason, created_at) VALUES (${input.reason}, ${input.now})
          `;
        }),
      ),
  } satisfies Record<string, (...args: never[]) => Effect.Effect<unknown, CloudError>>;
};
