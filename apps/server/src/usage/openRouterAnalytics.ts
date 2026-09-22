// @effect-diagnostics globalDate:off
import type {
  UsageAccountingKey,
  UsageAccountingMetrics,
  UsageAccountingRow,
  UsageAccountingSourceConfig,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const API = "https://openrouter.ai/api/v1";
const PAGE_SIZE = 100;
const MAX_KEY_PAGES = 100;
const MODEL_CATALOG_TTL_MS = 60 * 60 * 1_000;
const DESIRED_METRICS = [
  "request_count",
  "tokens_total",
  "tokens_prompt",
  "tokens_completion",
  "reasoning_tokens",
  "cached_tokens",
  "total_usage",
  "credits_usage",
  "byok_usage",
  "usage_upstream",
  "usage_cache",
  "usage_data",
  "usage_web",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function signedNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function integer(value: unknown): number {
  return Math.trunc(number(value));
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function limitReset(value: unknown): "daily" | "weekly" | "monthly" | null {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : null;
}

class OpenRouterAnalyticsError extends Data.TaggedError("OpenRouterAnalyticsError")<{
  readonly detail: string;
}> {}

export interface OpenRouterAnalyticsSnapshot {
  readonly keys: readonly UsageAccountingKey[];
  readonly rows: readonly UsageAccountingRow[];
  readonly truncated: boolean;
  readonly totalCreditsUsd: number | null;
  readonly totalUsageUsd: number | null;
  readonly failedKeys: number;
  readonly failedKeyIds: readonly string[];
  readonly creditsUnavailable: boolean;
  readonly workspaceDiscoveryUnavailable: boolean;
}

export const makeOpenRouterAnalytics = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  let modelCatalogCache:
    | {
        readonly expiresAtMs: number;
        readonly names: ReadonlyMap<string, string>;
      }
    | undefined;

  const request = Effect.fn("OpenRouterAnalytics.request")(function* (
    managementKey: string,
    path: string,
    body?: unknown,
  ) {
    const base =
      body === undefined
        ? HttpClientRequest.get(`${API}${path}`)
        : HttpClientRequest.post(`${API}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* client
      .execute(base.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${managementKey}`)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((value) => value.json),
        Effect.timeout("20 seconds"),
        Effect.mapError(
          () => new OpenRouterAnalyticsError({ detail: "OpenRouter rejected or timed out." }),
        ),
      );
    return response;
  });

  const listKeys = Effect.fn("OpenRouterAnalytics.listKeys")(function* (managementKey: string) {
    const workspaceIds: string[] = [];
    let workspaceDiscoveryUnavailable = false;
    for (let page = 0; page < MAX_KEY_PAGES; page += 1) {
      const workspaceResult = yield* Effect.result(
        request(managementKey, `/workspaces?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
      );
      // Workspace discovery is additive. Older/personal management accounts
      // may not expose it; the unscoped key listing must still work.
      if (Result.isFailure(workspaceResult)) {
        workspaceDiscoveryUnavailable = true;
        break;
      }
      const response = object(workspaceResult.success);
      const data = Array.isArray(response?.["data"]) ? response["data"] : null;
      if (data === null)
        return yield* new OpenRouterAnalyticsError({
          detail: "OpenRouter returned an invalid workspace list.",
        });
      for (const value of data) {
        const id = text(object(value)?.["id"]);
        if (id !== null) workspaceIds.push(id);
      }
      if (data.length < PAGE_SIZE) break;
      if (page === MAX_KEY_PAGES - 1)
        return yield* new OpenRouterAnalyticsError({
          detail: "OpenRouter workspace pagination exceeded 10,000 workspaces.",
        });
    }

    const keys = new Map<string, UsageAccountingKey>();
    // Unscoped covers the personal/default workspace; explicit workspace
    // queries cover organization workspaces. Duplicate hashes collapse.
    for (const workspaceId of [null, ...new Set(workspaceIds)]) {
      let offset = 0;
      let previousPageSignature: string | null = null;
      for (let page = 0; page < MAX_KEY_PAGES; page += 1) {
        const parameters = new URLSearchParams({
          include_disabled: "true",
          offset: String(offset),
          ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
        });
        const response = object(yield* request(managementKey, `/keys?${parameters}`));
        const data = Array.isArray(response?.["data"]) ? response["data"] : null;
        if (data === null)
          return yield* new OpenRouterAnalyticsError({
            detail: "OpenRouter returned an invalid key list.",
          });
        const pageSignature = data.map((value) => text(object(value)?.["hash"]) ?? "").join("\0");
        for (const value of data) {
          const key = object(value);
          const id = text(key?.["hash"]);
          if (key === null || id === null) continue;
          const name = text(key["name"]) ?? text(key["label"]) ?? `Key …${id.slice(-6)}`;
          keys.set(id, {
            id,
            name,
            ...(text(key["label"]) ? { label: text(key["label"])! } : {}),
            ...(text(key["workspace_id"]) ? { workspaceId: text(key["workspace_id"])! } : {}),
            disabled: key["disabled"] === true,
            limitUsd: nullableNumber(key["limit"]),
            limitRemainingUsd: nullableNumber(key["limit_remaining"]),
            limitReset: limitReset(key["limit_reset"]),
            includeByokInLimit: key["include_byok_in_limit"] === true,
            usageUsd: number(key["usage"]),
            usageDailyUsd: number(key["usage_daily"]),
            usageWeeklyUsd: number(key["usage_weekly"]),
            usageMonthlyUsd: number(key["usage_monthly"]),
            byokUsageUsd: number(key["byok_usage"]),
            expiresAt: text(key["expires_at"]),
          });
        }
        offset += data.length;
        const totalCount = nullableNumber(response?.["total_count"]);
        if (
          data.length === 0 ||
          (totalCount !== null && offset >= totalCount) ||
          pageSignature === previousPageSignature
        )
          break;
        previousPageSignature = pageSignature;
        if (page === MAX_KEY_PAGES - 1)
          return yield* new OpenRouterAnalyticsError({
            detail: `OpenRouter key pagination exceeded its safety limit${workspaceId ? " in one workspace" : ""}.`,
          });
      }
    }
    return { keys: [...keys.values()], workspaceDiscoveryUnavailable };
  });

  const readCredits = Effect.fn("OpenRouterAnalytics.readCredits")(function* (
    managementKey: string,
  ) {
    const response = object(yield* request(managementKey, "/credits"));
    const data = object(response?.["data"]);
    return {
      totalCreditsUsd: nullableNumber(data?.["total_credits"]),
      totalUsageUsd: nullableNumber(data?.["total_usage"]),
    };
  });

  const readModelNames = Effect.fn("OpenRouterAnalytics.readModelNames")(function* (
    managementKey: string,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (modelCatalogCache !== undefined && modelCatalogCache.expiresAtMs > nowMs) {
      return modelCatalogCache.names;
    }
    const response = object(yield* request(managementKey, "/models"));
    const data = Array.isArray(response?.["data"]) ? response["data"] : null;
    if (data === null) {
      return yield* new OpenRouterAnalyticsError({
        detail: "OpenRouter returned an invalid model catalog.",
      });
    }
    const names = new Map<string, string>();
    for (const value of data) {
      const model = object(value);
      const name = text(model?.["name"]);
      if (model === null || name === null) continue;
      for (const identifier of [text(model["id"]), text(model["canonical_slug"])]) {
        if (identifier !== null) names.set(identifier, name);
      }
    }
    modelCatalogCache = { expiresAtMs: nowMs + MODEL_CATALOG_TTL_MS, names };
    return names;
  });

  function reconcileGroupedKeyIds(
    rows: readonly UsageAccountingRow[],
    keys: readonly UsageAccountingKey[],
  ): readonly UsageAccountingRow[] {
    const normalizeAlias = (value: string) =>
      value
        .replace(/^key\s+(?:(?:\.{3}|…)\s*)?/iu, "")
        .replace(/^(?:\.{3}|…)\s*/u, "")
        .trim()
        .toLocaleLowerCase();
    const aliases = new Map<string, Set<string>>();
    for (const key of keys) {
      for (const alias of [key.id, key.name, key.label]) {
        if (alias === undefined) continue;
        for (const variant of new Set([alias, normalizeAlias(alias)])) {
          if (!variant) continue;
          const ids = aliases.get(variant) ?? new Set<string>();
          ids.add(key.id);
          aliases.set(variant, ids);
        }
      }
    }
    return rows.map((row) => {
      const ids = aliases.get(row.keyId) ?? aliases.get(normalizeAlias(row.keyId));
      const keyId = ids?.size === 1 ? [...ids][0]! : row.keyId;
      return keyId === row.keyId ? row : { ...row, keyId };
    });
  }

  const readCapabilities = Effect.fn("OpenRouterAnalytics.readCapabilities")(function* (
    managementKey: string,
  ) {
    const response = object(yield* request(managementKey, "/analytics/meta"));
    const data = object(response?.["data"]);
    const raw = data?.["metrics"];
    if (!Array.isArray(raw)) return { metrics: [...DESIRED_METRICS], supportsGroupedQuery: false };
    const available = new Set(
      raw.flatMap((value) => {
        if (typeof value === "string") return [value];
        const entry = object(value);
        const name = text(entry?.["name"]) ?? text(entry?.["id"]);
        return name === null ? [] : [name];
      }),
    );
    const selected = DESIRED_METRICS.filter((metric) => available.has(metric));
    // These three metrics are the minimum useful accounting contract. Let the
    // query produce a clear provider error rather than silently show zero.
    for (const required of ["request_count", "tokens_total", "total_usage"] as const) {
      if (!available.has(required)) {
        return yield* new OpenRouterAnalyticsError({
          detail: `OpenRouter analytics does not expose required metric '${required}'.`,
        });
      }
    }
    const rawDimensions = data?.["dimensions"];
    const dimensions = new Set(
      Array.isArray(rawDimensions)
        ? rawDimensions.flatMap((value) => {
            if (typeof value === "string") return [value];
            const entry = object(value);
            const name = text(entry?.["name"]) ?? text(entry?.["id"]);
            return name === null ? [] : [name];
          })
        : [],
    );
    return {
      metrics: selected,
      supportsGroupedQuery: dimensions.has("api_key_id") && dimensions.has("model"),
    };
  });

  const readRows = Effect.fn("OpenRouterAnalytics.readRows")(function* (
    managementKey: string,
    keyId: string | null,
    sinceDay: string,
    untilDay: string,
    metrics: readonly string[],
  ) {
    const end = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(`${untilDay}T00:00:00.000Z`), { days: 1 }),
    );
    const response = object(
      yield* request(managementKey, "/analytics/query", {
        metrics,
        dimensions: keyId === null ? ["api_key_id", "model"] : ["model"],
        granularity: "day",
        time_range: { start: `${sinceDay}T00:00:00.000Z`, end },
        ...(keyId === null
          ? {}
          : { filters: [{ field: "api_key_id", operator: "eq", value: keyId }] }),
        limit: 10_000,
      }),
    );
    const envelope = object(response?.["data"]);
    const data = Array.isArray(envelope?.["data"]) ? envelope["data"] : null;
    if (data === null)
      return yield* new OpenRouterAnalyticsError({
        detail: "OpenRouter returned invalid analytics data.",
      });
    const metadata = object(envelope?.["metadata"]);
    const rows: UsageAccountingRow[] = [];
    for (const value of data) {
      const row = object(value);
      const date = text(row?.["date__day"]);
      const model = text(row?.["model"]);
      const rowKeyId = keyId ?? text(row?.["api_key_id"]);
      if (row === null || date === null || model === null || rowKeyId === null) continue;
      const metrics: UsageAccountingMetrics = {
        requests: integer(row["request_count"]),
        totalTokens: integer(row["tokens_total"]),
        promptTokens: integer(row["tokens_prompt"]),
        completionTokens: integer(row["tokens_completion"]),
        reasoningTokens: integer(row["reasoning_tokens"]),
        cachedTokens: integer(row["cached_tokens"]),
        totalCostUsd: number(row["total_usage"]),
        creditsCostUsd: number(row["credits_usage"]),
        byokCostUsd: number(row["byok_usage"]),
        upstreamCostUsd: number(row["usage_upstream"]),
        cacheCostUsd: number(row["usage_cache"]),
        dataCostUsd: signedNumber(row["usage_data"]),
        webCostUsd: number(row["usage_web"]),
      };
      rows.push({
        day: date.slice(0, 10) as UsageAccountingRow["day"],
        keyId: rowKeyId,
        model,
        metrics,
      });
    }
    return { rows, truncated: metadata?.["truncated"] === true };
  });

  const readPerKeyRows = Effect.fn("OpenRouterAnalytics.readPerKeyRows")(function* (
    managementKey: string,
    keys: readonly UsageAccountingKey[],
    sinceDay: string,
    untilDay: string,
    metrics: readonly string[],
  ) {
    // Cap both in-flight work and starts per minute. Most accounts finish in
    // the first batch; large inventories avoid turning the 51st request into
    // an avoidable provider rate-limit failure.
    const results = yield* Effect.forEach(
      keys,
      (key, index) =>
        Effect.result(
          readRows(managementKey, key.id, sinceDay, untilDay, metrics).pipe(
            Effect.delay(`${Math.floor(index / 50) * 60} seconds`),
          ),
        ),
      { concurrency: 2 },
    );
    const rows: UsageAccountingRow[] = [];
    let truncated = false;
    let failedKeys = 0;
    const failedKeyIds: string[] = [];
    for (const [index, result] of results.entries()) {
      if (Result.isFailure(result)) {
        failedKeys += 1;
        failedKeyIds.push(keys[index]!.id);
        continue;
      }
      rows.push(...result.success.rows);
      truncated ||= result.success.truncated;
    }
    return { rows, truncated, failedKeys, failedKeyIds };
  });

  const readSnapshot = Effect.fn("OpenRouterAnalytics.readSnapshot")(function* (
    config: UsageAccountingSourceConfig,
    sinceDay: string,
    untilDay: string,
  ) {
    const managementKey = config.managementKey.trim();
    if (!managementKey) {
      return yield* new OpenRouterAnalyticsError({ detail: "A management key is required." });
    }
    const [keyInventory, creditsResult, capabilities, modelNamesResult] = yield* Effect.all(
      [
        listKeys(managementKey),
        Effect.result(readCredits(managementKey)),
        readCapabilities(managementKey),
        Effect.result(readModelNames(managementKey)),
      ],
      { concurrency: 4 },
    );
    const { keys, workspaceDiscoveryUnavailable } = keyInventory;
    let analytics:
      | {
          readonly rows: readonly UsageAccountingRow[];
          readonly truncated: boolean;
          readonly failedKeys: number;
          readonly failedKeyIds: readonly string[];
        }
      | undefined;
    if (capabilities.supportsGroupedQuery) {
      const grouped = yield* Effect.result(
        readRows(managementKey, null, sinceDay, untilDay, capabilities.metrics),
      );
      if (Result.isSuccess(grouped)) {
        analytics = { ...grouped.success, failedKeys: 0, failedKeyIds: [] };
      }
    }
    // Metadata can lag the query implementation. A failed grouped request
    // falls back to the slower per-key path instead of dropping fresh data.
    analytics ??= yield* readPerKeyRows(
      managementKey,
      keys,
      sinceDay,
      untilDay,
      capabilities.metrics,
    );
    const { rows: rawRows, truncated, failedKeys, failedKeyIds } = analytics;
    if (keys.length > 0 && failedKeys === keys.length) {
      return yield* new OpenRouterAnalyticsError({
        detail: "OpenRouter analytics failed for every API key.",
      });
    }
    const credits = Result.isSuccess(creditsResult)
      ? creditsResult.success
      : { totalCreditsUsd: null, totalUsageUsd: null };
    const modelNames = Result.isSuccess(modelNamesResult)
      ? modelNamesResult.success
      : new Map<string, string>();
    const rows = reconcileGroupedKeyIds(rawRows, keys).map((row) => {
      const modelName = modelNames.get(row.model);
      return modelName === undefined ? row : { ...row, modelName };
    });
    return {
      keys,
      rows,
      truncated,
      failedKeys,
      failedKeyIds,
      creditsUnavailable: Result.isFailure(creditsResult),
      workspaceDiscoveryUnavailable,
      ...credits,
    } satisfies OpenRouterAnalyticsSnapshot;
  });

  return { readSnapshot };
});
