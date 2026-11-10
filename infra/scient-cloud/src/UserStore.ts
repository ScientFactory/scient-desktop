// @effect-diagnostics globalJsonInEffect:off - stored JSON is this object's own, written from decoded input.
import type {
  CloudLimits,
  ComputerRecord,
  Ed25519PublicJwk,
  MovedThreadsResponse,
  ThreadIndexRow,
  ThreadMeta,
  ThreadRef,
} from "@scientfactory/scient-cloud/api";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { CloudError, failWith } from "./CloudError.ts";

/**
 * One user's cloud state, kept in that user's Durable Object (SQLite). Every write that
 * stores bytes is reserved here first, so quota checks are atomic per user.
 */

const NONCE_TTL_MS = 5 * 60_000;
/** Longer than any computer token can live (300 s + 60 s skew). */
const JTI_TTL_MS = 10 * 60_000;
/** A reservation not committed by then is an abandoned upload. */
const RESERVATION_TTL_MS = 15 * 60_000;

/** Limits without `usedBytes`; from Worker variables, overridable per user. */
export type BaseLimits = Omit<CloudLimits, "usedBytes">;

export const LimitsOverride = Schema.Struct({
  freeBytes: Schema.optionalKey(Schema.Int),
  maxSnapshotBytes: Schema.optionalKey(Schema.Int),
  maxBlobBytes: Schema.optionalKey(Schema.Int),
  maxThreads: Schema.optionalKey(Schema.Int),
});
export type LimitsOverride = typeof LimitsOverride.Type;
const LimitsOverrideJson = Schema.fromJsonString(LimitsOverride);
const decodeOverride = Schema.decodeUnknownOption(LimitsOverrideJson);
const encodeOverride = Schema.encodeSync(LimitsOverrideJson);

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const randomId = () => Base64Url.encode(crypto.getRandomValues(new Uint8Array(16)));
const seg = encodeURIComponent;

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS computers (
      env TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      public_key TEXT NOT NULL,
      enrolled_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )
  `;
  yield* sql`CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS jtis (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      env TEXT,
      thread TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS threads (
      env TEXT NOT NULL,
      thread TEXT NOT NULL,
      meta TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      generation INTEGER NOT NULL,
      moved_to TEXT,
      moved_at INTEGER,
      object_key TEXT,
      bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (env, thread)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS blobs (
      sha TEXT PRIMARY KEY,
      object_key TEXT NOT NULL,
      bytes INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS blob_refs (
      sha TEXT NOT NULL,
      env TEXT NOT NULL,
      thread TEXT NOT NULL,
      PRIMARY KEY (sha, env, thread)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS blob_refs_thread ON blob_refs (env, thread)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `;
});

interface ThreadRow {
  readonly env: string;
  readonly thread: string;
  readonly meta: string;
  readonly content_digest: string;
  readonly generation: number;
  readonly moved_to: string | null;
  readonly moved_at: number | null;
  readonly object_key: string | null;
  readonly bytes: number;
  readonly updated_at: number;
}

const getThreadRow = Effect.fn("UserStore.getThreadRow")(function* (env: string, thread: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<ThreadRow>`SELECT * FROM threads WHERE env = ${env} AND thread = ${thread}`;
  return rows[0];
});

const usage = Effect.fn("UserStore.usage")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM reservations WHERE created_at < ${now - RESERVATION_TTL_MS}`;
  const [row] = yield* sql<{ readonly used: number; readonly reserved: number }>`
    SELECT
      (SELECT COALESCE(SUM(bytes), 0) FROM threads)
        + (SELECT COALESCE(SUM(bytes), 0) FROM blobs)
        + (SELECT COALESCE(SUM(bytes), 0) FROM shares) AS used,
      (SELECT COALESCE(SUM(bytes), 0) FROM reservations) AS reserved
  `;
  return { used: Number(row?.used ?? 0), reserved: Number(row?.reserved ?? 0) };
});

const effectiveLimits = Effect.fn("UserStore.effectiveLimits")(function* (defaults: BaseLimits) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly value: string }>`
    SELECT value FROM settings WHERE key = 'limits_override'
  `;
  const override = rows[0] ? decodeOverride(rows[0].value) : undefined;
  return override?._tag === "Some" ? { ...defaults, ...override.value } : defaults;
});

const reserve = Effect.fn("UserStore.reserve")(function* (input: {
  readonly bytes: number;
  /** Bytes the write replaces, released when it commits. */
  readonly replacing: number;
  readonly limits: BaseLimits;
  readonly now: number;
  /** The conversation a computer upload is for; removing it or its computer cancels the upload. */
  readonly ref?: ThreadRef;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { used, reserved } = yield* usage(input.now);
  if (used - input.replacing + reserved + input.bytes > input.limits.freeBytes) {
    return yield* failWith("quota_exceeded", "Your cloud storage is full.");
  }
  const id = randomId();
  yield* sql`
    INSERT INTO reservations (id, bytes, created_at, env, thread)
    VALUES (${id}, ${input.bytes}, ${input.now}, ${input.ref?.env ?? null},
      ${input.ref?.thread ?? null})
  `;
  return id;
});

const requireEnrolled = Effect.fn("UserStore.requireEnrolled")(function* (env: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly env: string }>`SELECT env FROM computers WHERE env = ${env}`;
  if (rows.length === 0) return yield* failWith("unauthorized", "This computer is not enrolled.");
});

/**
 * Spends a computer upload's reservation. Stopping sync or deleting the conversation while the
 * bytes were on their way cancels it, so an upload that began before never lands after.
 */
const spendUpload = Effect.fn("UserStore.spendUpload")(function* (
  reservation: string,
  env: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* requireEnrolled(env);
  const spent = yield* sql<{ readonly id: string }>`
    DELETE FROM reservations WHERE id = ${reservation} RETURNING id
  `;
  if (spent.length === 0) {
    return yield* failWith("not_found", "This copy was removed while it was uploading.");
  }
});

/** Object keys a deletion leaves to remove from the bucket. */
const unreferencedBlobs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orphans = yield* sql<{ readonly sha: string; readonly object_key: string }>`
    SELECT sha, object_key FROM blobs
    WHERE NOT EXISTS (SELECT 1 FROM blob_refs WHERE blob_refs.sha = blobs.sha)
  `;
  for (const orphan of orphans) yield* sql`DELETE FROM blobs WHERE sha = ${orphan.sha}`;
  return orphans.map((orphan) => orphan.object_key);
});

const removeThreads = Effect.fn("UserStore.removeThreads")(function* (
  rows: ReadonlyArray<ThreadRow>,
) {
  const sql = yield* SqlClient.SqlClient;
  const keys: Array<string> = [];
  for (const row of rows) {
    yield* sql`DELETE FROM reservations WHERE env = ${row.env} AND thread = ${row.thread}`;
    yield* sql`DELETE FROM threads WHERE env = ${row.env} AND thread = ${row.thread}`;
    yield* sql`DELETE FROM blob_refs WHERE env = ${row.env} AND thread = ${row.thread}`;
    if (row.object_key) keys.push(row.object_key);
  }
  return [...keys, ...(yield* unreferencedBlobs)];
});

const toIndexRow = (row: ThreadRow, meta: ThreadMeta): ThreadIndexRow => ({
  ...meta,
  environmentId: row.env as ThreadIndexRow["environmentId"],
  threadId: row.thread as ThreadIndexRow["threadId"],
  ownerEnvironmentId: (row.moved_to ?? row.env) as ThreadIndexRow["ownerEnvironmentId"],
  movedTo: row.moved_to as ThreadIndexRow["movedTo"],
  bytes: row.bytes,
});

export type UserApi = ReturnType<typeof makeUserApi>;

/** Provides the object's SQL client; SQL failures are defects. */
export type RunSql = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => Effect.Effect<A, Exclude<E, SqlError>>;

/**
 * `run` provides the user's SQL client and serializes calls (one at a time per user).
 * `userId` only names bucket keys; the object is already scoped to that user.
 */
export const makeUserApi = (userId: string, run: RunSql) => {
  const userPrefix = `u/${seg(userId)}`;
  return {
    /** The wrapped data key; `candidate` is stored only when none exists yet. */
    dataKey: (candidate: string | null) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (candidate !== null) {
            yield* sql`
              INSERT INTO settings (key, value) VALUES ('data_key', ${candidate})
              ON CONFLICT (key) DO NOTHING
            `;
          }
          const rows = yield* sql<{ readonly value: string }>`
            SELECT value FROM settings WHERE key = 'data_key'
          `;
          return rows[0]?.value ?? null;
        }),
      ),

    createNonce: (now: number) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM nonces WHERE expires_at < ${now}`;
          const nonce = randomId();
          yield* sql`INSERT INTO nonces (nonce, expires_at) VALUES (${nonce}, ${now + NONCE_TTL_MS})`;
          return nonce;
        }),
      ),

    /** The proof was verified by the Worker; this consumes its nonce once. */
    enrollComputer: (input: {
      readonly environmentId: string;
      readonly label: string;
      readonly publicKey: Ed25519PublicJwk;
      readonly nonce: string;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const consumed = yield* sql<{ readonly nonce: string }>`
            DELETE FROM nonces WHERE nonce = ${input.nonce} AND expires_at >= ${input.now}
            RETURNING nonce
          `;
          if (consumed.length === 0) {
            return yield* failWith("unauthorized", "The enrollment nonce is unknown or expired.");
          }
          yield* sql`
            INSERT INTO computers (env, label, public_key, enrolled_at, last_seen_at)
            VALUES (${input.environmentId}, ${input.label}, ${JSON.stringify(input.publicKey)},
              ${input.now}, NULL)
            ON CONFLICT (env) DO UPDATE SET
              label = excluded.label,
              public_key = excluded.public_key,
              enrolled_at = excluded.enrolled_at
          `;
          return {
            environmentId: input.environmentId,
            label: input.label,
            enrolledAt: iso(input.now),
            lastSeenAt: null,
          } as ComputerRecord;
        }),
      ),

    listComputers: () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly env: string;
            readonly label: string;
            readonly enrolled_at: number;
            readonly last_seen_at: number | null;
          }>`SELECT env, label, enrolled_at, last_seen_at FROM computers ORDER BY enrolled_at`;
          return rows.map(
            (row) =>
              ({
                environmentId: row.env,
                label: row.label,
                enrolledAt: iso(row.enrolled_at),
                lastSeenAt: row.last_seen_at === null ? null : iso(row.last_seen_at),
              }) as ComputerRecord,
          );
        }),
      ),

    /**
     * Stops syncing: the computer can no longer upload or sign, and uploads on their way are
     * cancelled. Its copies stay readable; `deleteComputerCopies` removes them.
     */
    removeComputer: (env: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM computers WHERE env = ${env}`;
          yield* sql`DELETE FROM reservations WHERE env = ${env}`;
        }),
      ),

    /** Deletes every copy the computer made; returns bucket keys to delete. */
    deleteComputerCopies: (env: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM reservations WHERE env = ${env}`;
          const rows = yield* sql<ThreadRow>`SELECT * FROM threads WHERE env = ${env}`;
          return yield* removeThreads(rows);
        }),
      ),

    /** The computer's key and the user's limits (which bound the body it may send). */
    computerAuth: (env: string, defaults: BaseLimits) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly public_key: string }>`
            SELECT public_key FROM computers WHERE env = ${env}
          `;
          if (!rows[0]) return yield* failWith("unauthorized", "This computer is not enrolled.");
          return {
            publicKey: JSON.parse(rows[0].public_key) as Ed25519PublicJwk,
            limits: yield* effectiveLimits(defaults),
          };
        }),
      ),

    effectiveLimits: (defaults: BaseLimits) => run(effectiveLimits(defaults)),

    /** Single use of a verified computer token's `jti`. */
    consumeJti: (input: { readonly env: string; readonly jti: string; readonly now: number }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM jtis WHERE expires_at < ${input.now}`;
          const inserted = yield* sql<{ readonly jti: string }>`
            INSERT INTO jtis (jti, expires_at) VALUES (${input.jti}, ${input.now + JTI_TTL_MS})
            ON CONFLICT (jti) DO NOTHING
            RETURNING jti
          `;
          if (inserted.length === 0) {
            return yield* failWith("replayed", "This request was already received.");
          }
          yield* sql`UPDATE computers SET last_seen_at = ${input.now} WHERE env = ${input.env}`;
        }),
      ),

    limits: (defaults: BaseLimits, now: number) =>
      run(
        Effect.gen(function* () {
          const limits = yield* effectiveLimits(defaults);
          const { used } = yield* usage(now);
          return { ...limits, usedBytes: used } as CloudLimits;
        }),
      ),

    setLimitsOverride: (override: LimitsOverride | null) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (override === null) {
            yield* sql`DELETE FROM settings WHERE key = 'limits_override'`;
            return;
          }
          const value = encodeOverride(override);
          yield* sql`
            INSERT INTO settings (key, value) VALUES ('limits_override', ${value})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value
          `;
        }),
      ),

    /** Checks the lease and quota for an upload; `unchanged` skips the bucket write. */
    beginThreadPut: (input: {
      readonly env: string;
      readonly thread: string;
      readonly meta: ThreadMeta;
      readonly bytes: number;
      readonly defaults: BaseLimits;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* requireEnrolled(input.env);
          const limits = yield* effectiveLimits(input.defaults);
          const row = yield* getThreadRow(input.env, input.thread);
          if (row && (row.moved_to !== null || input.meta.generation < row.generation)) {
            return yield* failWith(
              "lease_lost",
              "This conversation continues on another computer.",
              row.moved_to,
            );
          }
          if (
            row?.object_key &&
            row.content_digest === input.meta.contentDigest &&
            row.generation === input.meta.generation
          ) {
            yield* sql`
              UPDATE threads SET meta = ${JSON.stringify(input.meta)}, updated_at = ${input.now}
              WHERE env = ${input.env} AND thread = ${input.thread}
            `;
            return { status: "unchanged" as const };
          }
          if (input.bytes > limits.maxSnapshotBytes) {
            return yield* failWith("too_large", "This conversation is too large to copy.");
          }
          if (!row) {
            const [count] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM threads`;
            if (Number(count?.n ?? 0) >= limits.maxThreads) {
              return yield* failWith("quota_exceeded", "You have reached the conversation limit.");
            }
          }
          const reservation = yield* reserve({
            bytes: input.bytes,
            replacing: row?.bytes ?? 0,
            limits,
            now: input.now,
            ref: { env: input.env, thread: input.thread } as ThreadRef,
          });
          return {
            status: "upload" as const,
            reservation,
            objectKey: `${userPrefix}/t/${seg(input.env)}/${seg(input.thread)}/${reservation}`,
          };
        }),
      ),

    /**
     * Records the stored copy; returns the replaced object to delete. A lease taken, the
     * conversation deleted or the computer removed meanwhile wins.
     */
    commitThreadPut: (input: {
      readonly env: string;
      readonly thread: string;
      readonly meta: ThreadMeta;
      readonly reservation: string;
      readonly objectKey: string;
      readonly bytes: number;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* spendUpload(input.reservation, input.env);
          const row = yield* getThreadRow(input.env, input.thread);
          if (row && (row.moved_to !== null || input.meta.generation < row.generation)) {
            return yield* failWith(
              "lease_lost",
              "This conversation continues on another computer.",
              row.moved_to,
            );
          }
          yield* sql`
            INSERT INTO threads (env, thread, meta, content_digest, generation, moved_to, moved_at,
              object_key, bytes, updated_at)
            VALUES (${input.env}, ${input.thread}, ${JSON.stringify(input.meta)},
              ${input.meta.contentDigest}, ${input.meta.generation}, NULL, NULL, ${input.objectKey},
              ${input.bytes}, ${input.now})
            ON CONFLICT (env, thread) DO UPDATE SET
              meta = excluded.meta,
              content_digest = excluded.content_digest,
              generation = excluded.generation,
              object_key = excluded.object_key,
              bytes = excluded.bytes,
              updated_at = excluded.updated_at
          `;
          return row?.object_key ?? null;
        }),
      ),

    release: (reservation: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM reservations WHERE id = ${reservation}`;
        }),
      ),

    listThreads: () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<ThreadRow>`
            SELECT * FROM threads WHERE object_key IS NOT NULL ORDER BY updated_at DESC
          `;
          return rows.map((row) => toIndexRow(row, JSON.parse(row.meta) as ThreadMeta));
        }),
      ),

    getThread: (env: string, thread: string) =>
      run(
        Effect.gen(function* () {
          const row = yield* getThreadRow(env, thread);
          if (!row?.object_key)
            return yield* failWith("not_found", "No cloud copy of this thread.");
          return { objectKey: row.object_key, generation: row.generation };
        }),
      ),

    deleteThread: (env: string, thread: string) =>
      run(
        Effect.gen(function* () {
          const row = yield* getThreadRow(env, thread);
          if (row) return yield* removeThreads([row]);
          // A first copy still on its way has no row yet; cancel it so it never lands.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM reservations WHERE env = ${env} AND thread = ${thread}`;
          return [];
        }),
      ),

    /** Moves ownership to `to` (back to the thread's own computer clears the move). */
    lease: (input: {
      readonly env: string;
      readonly thread: string;
      readonly to: string;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const computers = yield* sql<{ readonly env: string }>`
            SELECT env FROM computers WHERE env = ${input.to}
          `;
          if (computers.length === 0) {
            return yield* failWith("forbidden", "That computer is not one of yours.");
          }
          const row = yield* getThreadRow(input.env, input.thread);
          if (!row?.object_key)
            return yield* failWith("not_found", "No cloud copy of this thread.");
          const generation = row.generation + 1;
          const movedTo = input.to === input.env ? null : input.to;
          yield* sql`
            UPDATE threads SET generation = ${generation}, moved_to = ${movedTo},
              moved_at = ${movedTo === null ? null : input.now}
            WHERE env = ${input.env} AND thread = ${input.thread}
          `;
          return { generation, objectKey: row.object_key };
        }),
      ),

    movedSince: (env: string, since: number) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<ThreadRow>`
            SELECT * FROM threads
            WHERE env = ${env} AND moved_to IS NOT NULL AND moved_at > ${since}
            ORDER BY moved_at
          `;
          return rows.map((row) => ({
            threadId: row.thread,
            movedTo: row.moved_to,
            generation: row.generation,
            movedAt: iso(row.moved_at ?? 0),
          })) as unknown as MovedThreadsResponse["threads"];
        }),
      ),

    /** True when stored; records that `ref` uses it, so a later upload of `ref` can be read. */
    blobHead: (sha: string, ref: ThreadRef) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly sha: string;
          }>`SELECT sha FROM blobs WHERE sha = ${sha}`;
          if (rows.length === 0) return false;
          yield* sql`
            INSERT INTO blob_refs (sha, env, thread) VALUES (${sha}, ${ref.env}, ${ref.thread})
            ON CONFLICT DO NOTHING
          `;
          return true;
        }),
      ),

    beginBlobPut: (input: {
      readonly sha: string;
      readonly ref: ThreadRef;
      readonly bytes: number;
      readonly defaults: BaseLimits;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* requireEnrolled(input.ref.env);
          const limits = yield* effectiveLimits(input.defaults);
          const existing = yield* sql<{ readonly sha: string }>`
            SELECT sha FROM blobs WHERE sha = ${input.sha}
          `;
          if (existing.length > 0) {
            yield* sql`
              INSERT INTO blob_refs (sha, env, thread)
              VALUES (${input.sha}, ${input.ref.env}, ${input.ref.thread})
              ON CONFLICT DO NOTHING
            `;
            return { status: "exists" as const };
          }
          if (input.bytes > limits.maxBlobBytes) {
            return yield* failWith("too_large", "This file is too large to copy.");
          }
          const reservation = yield* reserve({
            bytes: input.bytes,
            replacing: 0,
            limits,
            now: input.now,
            ref: input.ref,
          });
          return {
            status: "upload" as const,
            reservation,
            objectKey: `${userPrefix}/b/${input.sha}/${reservation}`,
          };
        }),
      ),

    /** Returns a duplicate object to delete when another upload of the same bytes won. */
    commitBlobPut: (input: {
      readonly sha: string;
      readonly ref: ThreadRef;
      readonly reservation: string;
      readonly objectKey: string;
      readonly bytes: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* spendUpload(input.reservation, input.ref.env);
          const inserted = yield* sql<{ readonly sha: string }>`
            INSERT INTO blobs (sha, object_key, bytes)
            VALUES (${input.sha}, ${input.objectKey}, ${input.bytes})
            ON CONFLICT (sha) DO NOTHING
            RETURNING sha
          `;
          yield* sql`
            INSERT INTO blob_refs (sha, env, thread)
            VALUES (${input.sha}, ${input.ref.env}, ${input.ref.thread})
            ON CONFLICT DO NOTHING
          `;
          return inserted.length === 0 ? input.objectKey : null;
        }),
      ),

    /** Only blobs a stored thread of this user refers to can be read. */
    blobForRead: (sha: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly object_key: string; readonly bytes: number }>`
            SELECT blobs.object_key, blobs.bytes FROM blobs
            WHERE blobs.sha = ${sha} AND EXISTS (
              SELECT 1 FROM blob_refs JOIN threads
                ON threads.env = blob_refs.env AND threads.thread = blob_refs.thread
              WHERE blob_refs.sha = blobs.sha AND threads.object_key IS NOT NULL
            )
          `;
          if (!rows[0]) return yield* failWith("not_found", "No such file.");
          return { objectKey: rows[0].object_key, bytes: rows[0].bytes };
        }),
      ),

    addShare: (id: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO shares (id, bytes) VALUES (${id}, 0) ON CONFLICT DO NOTHING`;
        }),
      ),

    ownsShare: (id: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly id: string }>`SELECT id FROM shares WHERE id = ${id}`;
          if (rows.length === 0) return yield* failWith("not_found", "No such shared link.");
        }),
      ),

    listShares: () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly id: string }>`SELECT id FROM shares`;
          return rows.map((row) => row.id);
        }),
      ),

    /** Reserves `bytes` for a share object that replaces `replacing` stored bytes. */
    beginShareWrite: (input: {
      readonly id: string;
      readonly bytes: number;
      readonly replacing: number;
      readonly defaults: BaseLimits;
      readonly now: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const owned = yield* sql<{ readonly id: string }>`
            SELECT id FROM shares WHERE id = ${input.id}
          `;
          if (owned.length === 0) return yield* failWith("not_found", "No such shared link.");
          const limits = yield* effectiveLimits(input.defaults);
          if (input.bytes > limits.maxSnapshotBytes) {
            return yield* failWith("too_large", "This shared object is too large.");
          }
          return yield* reserve({
            bytes: input.bytes,
            replacing: input.replacing,
            limits,
            now: input.now,
          });
        }),
      ),

    /**
     * Takes the share's own total after one of its writes. Writes can report out of order, so
     * only a newer `revision` replaces the total: usage ends equal to what the share stores.
     */
    commitShareWrite: (input: {
      readonly id: string;
      readonly reservation: string;
      readonly totalBytes: number;
      readonly revision: number;
    }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM reservations WHERE id = ${input.reservation}`;
          yield* sql`
            UPDATE shares SET bytes = ${input.totalBytes}, revision = ${input.revision}
            WHERE id = ${input.id} AND revision < ${input.revision}
          `;
        }),
      ),

    removeShare: (id: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM shares WHERE id = ${id}`;
        }),
      ),
  } satisfies Record<string, (...args: never[]) => Effect.Effect<unknown, CloudError>>;
};
