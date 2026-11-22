// @effect-diagnostics nodeBuiltinImport:off - the local stand-in keeps the database and files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DEFAULT_FEEDBACK_SETTINGS,
  FeedbackConfig,
  FeedbackSql,
  Files,
  RateLimits,
  type FeedbackSettings,
  type RateLimitKind,
  type SqlValue,
  type StoredFile,
} from "./Services.ts";

/**
 * The Worker's services in one Node process, for the tests and `scripts/dev.ts`. The deployed
 * Worker never imports this file.
 */

const MIGRATIONS = NodePath.resolve(import.meta.dirname, "..", "migrations");

export const sqliteFeedbackSql = (filename = ":memory:"): FeedbackSql["Service"] => {
  if (filename !== ":memory:") NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(filename);
  const applied = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reports'")
    .get();
  if (applied === undefined) {
    for (const file of NodeFS.readdirSync(MIGRATIONS).toSorted()) {
      database.exec(NodeFS.readFileSync(NodePath.join(MIGRATIONS, file), "utf8"));
    }
  }
  const params = (values: ReadonlyArray<SqlValue>) => values as Array<SqlValue>;
  return {
    run: (sql, values = []) =>
      Effect.sync(() => {
        const result = database.prepare(sql).run(...params(values));
        return { changes: Number(result.changes) };
      }),
    first: <Row>(sql: string, values: ReadonlyArray<SqlValue> = []) =>
      Effect.sync(() => database.prepare(sql).get(...params(values)) as Row | undefined),
    all: <Row>(sql: string, values: ReadonlyArray<SqlValue> = []) =>
      Effect.sync(
        () => database.prepare(sql).all(...params(values)) as unknown as ReadonlyArray<Row>,
      ),
  };
};

export const memoryFiles = (store = new Map<string, StoredFile>()): Files["Service"] => ({
  put: (key, bytes, contentType) => Effect.sync(() => void store.set(key, { bytes, contentType })),
  get: (key) => Effect.sync(() => store.get(key)),
  delete: (keys) => Effect.sync(() => keys.forEach((key) => store.delete(key))),
});

export const directoryFiles = (root: string): Files["Service"] => {
  const pathOf = (key: string) => NodePath.join(root, ...key.split("/"));
  return {
    put: (key, bytes, contentType) =>
      Effect.sync(() => {
        NodeFS.mkdirSync(NodePath.dirname(pathOf(key)), { recursive: true });
        NodeFS.writeFileSync(pathOf(key), bytes);
        NodeFS.writeFileSync(`${pathOf(key)}.type`, contentType);
      }),
    get: (key) =>
      Effect.sync(() =>
        NodeFS.existsSync(pathOf(key))
          ? {
              bytes: new Uint8Array(NodeFS.readFileSync(pathOf(key))),
              contentType: NodeFS.readFileSync(`${pathOf(key)}.type`, "utf8"),
            }
          : undefined,
      ),
    delete: (keys) =>
      Effect.sync(() =>
        keys.forEach((key) => {
          NodeFS.rmSync(pathOf(key), { force: true });
          NodeFS.rmSync(`${pathOf(key)}.type`, { force: true });
        }),
      ),
  };
};

/** The deployed limits (see `src/worker.ts`) as fixed one-minute windows. */
export const LOCAL_RATE_LIMITS: Record<RateLimitKind, number> = {
  "report-client": 3,
  "report-network": 10,
  "status-client": 10,
};

export const memoryRateLimits = (
  limits: Record<RateLimitKind, number> = LOCAL_RATE_LIMITS,
): RateLimits["Service"] => {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow: (kind, key) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const id = `${kind}:${key}`;
          const window = windows.get(id);
          if (window === undefined || now - window.start >= 60_000) {
            windows.set(id, { start: now, count: 1 });
            return true;
          }
          window.count += 1;
          return window.count <= limits[kind];
        }),
      ),
  };
};

export interface LocalFeedbackOptions {
  readonly sql?: FeedbackSql["Service"];
  readonly files?: Files["Service"];
  readonly rateLimits?: RateLimits["Service"];
  readonly settings?: Partial<FeedbackSettings>;
}

export const layer = (options: LocalFeedbackOptions = {}) =>
  Layer.mergeAll(
    Layer.succeed(FeedbackSql, options.sql ?? sqliteFeedbackSql()),
    Layer.succeed(Files, options.files ?? memoryFiles()),
    Layer.succeed(RateLimits, options.rateLimits ?? memoryRateLimits()),
    Layer.succeed(FeedbackConfig, { ...DEFAULT_FEEDBACK_SETTINGS, ...options.settings }),
  );
