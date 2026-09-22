import {
  UsageAccountingKey,
  UsageAccountingRow,
  type UsageAccountingSourceConfig,
  type UsageAccountingSourceId,
  type UsageAccountingSourceSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { makeOpenRouterAnalytics } from "./openRouterAnalytics.ts";

const CacheSource = Schema.Struct({
  lastSyncedAt: Schema.String,
  keys: Schema.Array(UsageAccountingKey),
  rows: Schema.Array(UsageAccountingRow),
  totalCreditsUsd: Schema.NullOr(Schema.Number),
  totalUsageUsd: Schema.NullOr(Schema.Number),
});
const Cache = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Record(Schema.String, CacheSource),
});
type CacheSourceValue = typeof CacheSource.Type;
interface MutableCache {
  readonly version: 1;
  readonly sources: Record<string, CacheSourceValue>;
}
const CacheJson = Schema.fromJsonString(Cache);
const decodeCache = Schema.decodeUnknownOption(CacheJson);
const encodeCache = Schema.encodeEffect(CacheJson);
const RETENTION_DAYS = 400;

function parseCache(raw: string): MutableCache {
  const decoded = decodeCache(raw);
  return Option.isSome(decoded)
    ? { version: 1, sources: { ...decoded.value.sources } }
    : { version: 1, sources: {} };
}

function boundedMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "OpenRouter accounting failed.";
  return detail.slice(0, 240) || "OpenRouter accounting failed.";
}

export const makeUsageAccounting = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const api = yield* makeOpenRouterAnalytics;
  const lock = yield* Semaphore.make(1);

  const read = Effect.fn("UsageAccounting.read")(function* (input: {
    readonly cachePath: string;
    readonly query: UsageSummaryInput;
    readonly sources: Readonly<Record<string, UsageAccountingSourceConfig>>;
  }) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const raw = yield* fs
          .readFileString(input.cachePath)
          .pipe(Effect.catchCause(() => Effect.succeed("")));
        const cache = parseCache(raw);
        const summaries: UsageAccountingSourceSummary[] = [];
        let dirty = false;
        const nowMs = yield* Clock.currentTimeMillis;
        const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const retentionDay = DateTime.formatIso(
          DateTime.makeUnsafe(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000),
        ).slice(0, 10);

        for (const [rawSourceId, config] of Object.entries(input.sources)) {
          if (!config.enabled) continue;
          const sourceId = rawSourceId as UsageAccountingSourceId;
          const label = config.label?.trim() || "OpenRouter";
          const prior = cache.sources[rawSourceId];
          const result = yield* Effect.result(
            api.readSnapshot(config, input.query.sinceDay, input.query.untilDay),
          );
          if (Result.isSuccess(result)) {
            const failedKeyIds = new Set(result.success.failedKeyIds);
            const currentKeyIds = new Set(result.success.keys.map((key) => key.id));
            const refreshedKeyIds = new Set(result.success.rows.map((row) => row.keyId));
            const cachedRowsForFailedKeys = (prior?.rows ?? []).filter(
              (row) =>
                failedKeyIds.has(row.keyId) &&
                row.day >= input.query.sinceDay &&
                row.day <= input.query.untilDay,
            );
            // A deleted key disappears from the key inventory and cannot be queried
            // by the compatibility per-key path. Its already-synced history remains
            // provider-billed history and must not silently vanish from the ledger.
            const cachedRowsForRemovedKeys = (prior?.rows ?? []).filter(
              (row) =>
                !currentKeyIds.has(row.keyId) &&
                !refreshedKeyIds.has(row.keyId) &&
                row.day >= input.query.sinceDay &&
                row.day <= input.query.untilDay,
            );
            const currentRows = [
              ...result.success.rows,
              ...cachedRowsForFailedKeys,
              ...cachedRowsForRemovedKeys,
            ];
            const rowsOutsideWindow = (prior?.rows ?? []).filter(
              (row) =>
                (row.day < input.query.sinceDay || row.day > input.query.untilDay) &&
                row.day >= retentionDay,
            );
            const next = {
              lastSyncedAt: now,
              keys: result.success.keys,
              rows: [...rowsOutsideWindow, ...currentRows],
              totalCreditsUsd: result.success.totalCreditsUsd,
              totalUsageUsd: result.success.totalUsageUsd,
            };
            const issues = [
              result.success.truncated
                ? "OpenRouter truncated at least one key query; totals may be incomplete."
                : null,
              result.success.failedKeys > 0
                ? `${result.success.failedKeys} API key queries failed; cached rows are shown where available.`
                : null,
              result.success.creditsUnavailable
                ? "Usage is current, but OpenRouter credits could not be refreshed."
                : null,
              result.success.workspaceDiscoveryUnavailable
                ? "Usage may exclude organization workspaces because OpenRouter workspace discovery failed."
                : null,
            ].filter((issue): issue is string => issue !== null);
            cache.sources[rawSourceId] = next;
            dirty = true;
            summaries.push({
              sourceId,
              kind: "openrouter",
              label,
              status:
                result.success.truncated ||
                result.success.failedKeys > 0 ||
                result.success.creditsUnavailable ||
                result.success.workspaceDiscoveryUnavailable
                  ? "partial"
                  : "ok",
              lastSyncedAt: now,
              message: issues.length > 0 ? issues.join(" ") : null,
              truncated: result.success.truncated,
              totalCreditsUsd: next.totalCreditsUsd,
              totalUsageUsd: next.totalUsageUsd,
              keys: next.keys,
              rows: currentRows,
            });
            continue;
          }

          const cachedRows = (prior?.rows ?? []).filter(
            (row) => row.day >= input.query.sinceDay && row.day <= input.query.untilDay,
          );
          summaries.push({
            sourceId,
            kind: "openrouter",
            label,
            status: prior === undefined ? "failed" : "cached",
            lastSyncedAt: prior?.lastSyncedAt ?? null,
            message: boundedMessage(result.failure),
            truncated: false,
            totalCreditsUsd: prior?.totalCreditsUsd ?? null,
            totalUsageUsd: prior?.totalUsageUsd ?? null,
            keys: prior?.keys ?? [],
            rows: cachedRows,
          });
        }

        if (dirty) {
          const nextPath = `${input.cachePath}.next`;
          yield* encodeCache(cache).pipe(
            Effect.flatMap((serialized) => fs.writeFileString(nextPath, serialized)),
            Effect.andThen(fs.rename(nextPath, input.cachePath)),
            Effect.catchCause(() => Effect.void),
          );
        }
        return summaries;
      }),
    );
  });

  return { read };
});
