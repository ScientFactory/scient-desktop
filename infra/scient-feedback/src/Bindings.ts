import type * as Workers from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

import type { FeedbackSql, Files, RateLimitKind, RateLimits } from "./Services.ts";

export const d1FeedbackSql = (database: Workers.D1Database): FeedbackSql["Service"] => ({
  run: (sql, params = []) =>
    Effect.promise(() =>
      database
        .prepare(sql)
        .bind(...params)
        .run(),
    ).pipe(Effect.map((result) => ({ changes: result.meta.changes }))),
  first: <Row>(sql: string, params: ReadonlyArray<string | number | null> = []) =>
    Effect.promise(() =>
      database
        .prepare(sql)
        .bind(...params)
        .first<Row>(),
    ).pipe(Effect.map((row) => row ?? undefined)),
  all: <Row>(sql: string, params: ReadonlyArray<string | number | null> = []) =>
    Effect.promise(() =>
      database
        .prepare(sql)
        .bind(...params)
        .all<Row>(),
    ).pipe(Effect.map((result) => result.results)),
});

export const r2Files = (bucket: Workers.R2Bucket): Files["Service"] => ({
  put: (key, bytes, contentType) =>
    Effect.promise(() => bucket.put(key, bytes, { httpMetadata: { contentType } })).pipe(
      Effect.asVoid,
    ),
  get: (key) =>
    Effect.promise(async () => {
      const object = await bucket.get(key);
      if (object === null) return undefined;
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    }),
  delete: (keys) =>
    keys.length === 0 ? Effect.void : Effect.promise(() => bucket.delete([...keys])),
});

export const bindingRateLimits = (
  bindings: Record<RateLimitKind, Workers.RateLimit>,
): RateLimits["Service"] => ({
  allow: (kind, key) =>
    Effect.promise(() => bindings[kind].limit({ key })).pipe(
      Effect.map((outcome) => outcome.success),
    ),
});
