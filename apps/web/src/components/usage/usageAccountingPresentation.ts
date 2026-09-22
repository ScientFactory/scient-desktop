import type {
  PiUsageRow,
  UsageAccountingKey,
  UsageAccountingMetrics,
  UsageAccountingRow,
  UsageAccountingSourceStatus,
  UsageAccountingSourceSummary,
  UsageSummary,
  UsageTokenTotals,
} from "@t3tools/contracts";

export const EMPTY_ACCOUNTING_METRICS: UsageAccountingMetrics = {
  requests: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalCostUsd: 0,
  creditsCostUsd: 0,
  byokCostUsd: 0,
  upstreamCostUsd: 0,
  cacheCostUsd: 0,
  dataCostUsd: 0,
  webCostUsd: 0,
};

export type AccountingChartMetric = "spend" | "tokens" | "requests";
export type AccountingChartGroup = "model" | "key";

export interface AccountingDisplayRow {
  readonly keyId: string;
  readonly key: UsageAccountingKey | null;
  readonly model: string;
  readonly modelName: string;
  readonly metrics: UsageAccountingMetrics;
}

export interface PiDisplayRow {
  readonly id: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly provider: string;
  readonly model: string;
  readonly modelName: string;
  readonly totals: UsageTokenTotals;
  readonly cost: number;
  readonly records: number;
  readonly sessions: number;
  readonly generations: number;
}

export interface AccountingTrendSeries {
  readonly id: string;
  readonly label: string;
  readonly values: readonly number[];
  readonly total: number;
  readonly colorIndex: number;
}

export interface AccountingTrend {
  readonly periods: readonly string[];
  readonly series: readonly AccountingTrendSeries[];
}

const MODEL_ACRONYMS = new Set(["ai", "api", "glm", "gpt", "llm", "vl"]);

/** Readable fallback for old/cached analytics rows that predate catalog names. */
export function formatAccountingModelName(model: string): string {
  const slug = model.split("/").at(-1) ?? model;
  const withoutSnapshot = slug.replace(/-(?:19|20)\d{2}(?:-?\d{2}){2}$/u, "");
  return withoutSnapshot
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (MODEL_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (/^[rv]\d/iu.test(part)) return `${part[0]!.toUpperCase()}${part.slice(1)}`;
      return `${part[0]!.toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

export function formatAccountingKeyName(keyId: string): string {
  const readable = keyId
    .replace(/^key\s+(?:(?:\.{3}|…)\s*)?/iu, "")
    .replace(/^(?:\.{3}|…)\s*/u, "")
    .trim();
  if (readable.length > 0 && !/^[a-f\d]{24,}$/iu.test(readable)) return readable;
  return `API key …${keyId.slice(-6)}`;
}

export function addAccountingMetrics(
  left: UsageAccountingMetrics,
  right: UsageAccountingMetrics,
): UsageAccountingMetrics {
  return Object.fromEntries(
    Object.keys(EMPTY_ACCOUNTING_METRICS).map((key) => [
      key,
      left[key as keyof UsageAccountingMetrics] + right[key as keyof UsageAccountingMetrics],
    ]),
  ) as unknown as UsageAccountingMetrics;
}

function sourceFingerprint(source: UsageAccountingSourceSummary): string {
  return (
    source.keys
      .map((key) => key.id)
      .toSorted()
      .join("\0") || source.sourceId
  );
}

function sourcePriority(status: UsageAccountingSourceStatus): number {
  switch (status) {
    case "ok":
      return 4;
    case "partial":
      return 3;
    case "cached":
      return 2;
    case "failed":
      return 1;
  }
}

export function aggregateAccounting(summaries: readonly UsageSummary[]) {
  const sources = summaries.flatMap((summary) => summary.accounting?.sources ?? []);
  const uniqueSources = new Map<string, UsageAccountingSourceSummary>();
  for (const source of sources) {
    const fingerprint = sourceFingerprint(source);
    const current = uniqueSources.get(fingerprint);
    const sourceRank = sourcePriority(source.status);
    const currentRank = current === undefined ? -1 : sourcePriority(current.status);
    if (
      current === undefined ||
      sourceRank > currentRank ||
      (sourceRank === currentRank && (source.lastSyncedAt ?? "") > (current.lastSyncedAt ?? ""))
    ) {
      uniqueSources.set(fingerprint, source);
    }
  }

  const selectedSources = [...uniqueSources.values()];
  const keys = new Map<string, UsageAccountingKey>();
  const rows = new Map<string, AccountingDisplayRow>();
  const sourceRows: UsageAccountingRow[] = [];
  let totals = EMPTY_ACCOUNTING_METRICS;
  for (const source of selectedSources) {
    for (const key of source.keys) keys.set(key.id, key);
    sourceRows.push(...source.rows);
    for (const row of source.rows) {
      const id = `${row.keyId}\0${row.model}`;
      const current = rows.get(id);
      rows.set(id, {
        keyId: row.keyId,
        key: keys.get(row.keyId) ?? null,
        model: row.model,
        modelName: row.modelName ?? formatAccountingModelName(row.model),
        metrics:
          current === undefined ? row.metrics : addAccountingMetrics(current.metrics, row.metrics),
      });
      totals = addAccountingMetrics(totals, row.metrics);
    }
  }

  const knownBalances = selectedSources.flatMap((source) =>
    source.totalCreditsUsd === null || source.totalUsageUsd === null
      ? []
      : [Math.max(0, source.totalCreditsUsd - source.totalUsageUsd)],
  );
  const lastSyncedAt = selectedSources
    .flatMap((source) => (source.lastSyncedAt === null ? [] : [source.lastSyncedAt]))
    .toSorted()
    .at(-1);
  const status = selectedSources.reduce<UsageAccountingSourceStatus | null>((current, source) => {
    if (current === null) return source.status;
    return sourcePriority(source.status) < sourcePriority(current) ? source.status : current;
  }, null);
  const state =
    selectedSources.length === 0
      ? ("unconfigured" as const)
      : sourceRows.length > 0
        ? ("available" as const)
        : selectedSources.every((source) => source.status === "failed")
          ? ("unavailable" as const)
          : ("empty" as const);

  return {
    sources: selectedSources,
    keys,
    sourceRows,
    rows: [...rows.values()].toSorted(
      (a, b) => b.metrics.totalCostUsd - a.metrics.totalCostUsd || a.model.localeCompare(b.model),
    ),
    totals,
    creditsRemainingUsd:
      knownBalances.length === 0 ? null : knownBalances.reduce((sum, value) => sum + value, 0),
    lastSyncedAt: lastSyncedAt ?? null,
    status,
    state,
    pi: groupPiUsage(summaries.flatMap((summary) => summary.accounting?.pi ?? [])),
  };
}

export type AccountingAggregate = ReturnType<typeof aggregateAccounting>;

function addTokenTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

export function groupPiUsage(rows: readonly PiUsageRow[]): readonly PiDisplayRow[] {
  const grouped = new Map<string, PiDisplayRow>();
  for (const row of rows) {
    const id = `${row.connectionId}\0${row.provider}\0${row.model}`;
    const current = grouped.get(id);
    grouped.set(
      id,
      current === undefined
        ? {
            id,
            connectionId: row.connectionId,
            connectionName: row.connectionName ?? `Connection …${row.connectionId.slice(-6)}`,
            provider: row.provider,
            model: row.model,
            modelName: row.modelName ?? row.model,
            totals: row.totals,
            cost: row.estimatedCostUsd,
            records: row.records,
            sessions: row.sessions,
            generations: row.generations,
          }
        : {
            ...current,
            totals: addTokenTotals(current.totals, row.totals),
            cost: current.cost + row.estimatedCostUsd,
            records: current.records + row.records,
            sessions: current.sessions + row.sessions,
            generations: current.generations + row.generations,
          },
    );
  }
  return [...grouped.values()].toSorted(
    (a, b) => b.cost - a.cost || b.records - a.records || a.modelName.localeCompare(b.modelName),
  );
}

function metricValue(metrics: UsageAccountingMetrics, metric: AccountingChartMetric): number {
  switch (metric) {
    case "spend":
      return metrics.totalCostUsd;
    case "tokens":
      return metrics.totalTokens;
    case "requests":
      return metrics.requests;
  }
}

export function buildAccountingTrend(input: {
  readonly rows: readonly UsageAccountingRow[];
  readonly keys: ReadonlyMap<string, UsageAccountingKey>;
  readonly metric: AccountingChartMetric;
  readonly group: AccountingChartGroup;
  readonly maxSeries?: number;
}): AccountingTrend {
  const periods = [...new Set(input.rows.map((row) => row.day))].toSorted();
  const totals = new Map<string, number>();
  const values = new Map<string, Map<string, number>>();
  for (const row of input.rows) {
    const id = input.group === "model" ? row.model : row.keyId;
    const value = metricValue(row.metrics, input.metric);
    totals.set(id, (totals.get(id) ?? 0) + value);
    const byPeriod = values.get(id) ?? new Map<string, number>();
    byPeriod.set(row.day, (byPeriod.get(row.day) ?? 0) + value);
    values.set(id, byPeriod);
  }

  const maxSeries = input.maxSeries ?? 5;
  const ranked = [...totals].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const visible = ranked.slice(0, maxSeries);
  const hidden = ranked.slice(maxSeries);
  const modelNames = new Map<string, string>();
  for (const row of input.rows) {
    if (row.modelName !== undefined) modelNames.set(row.model, row.modelName);
  }
  const series: AccountingTrendSeries[] = visible.map(([id, total], colorIndex) => ({
    id,
    label:
      input.group === "model"
        ? (modelNames.get(id) ?? formatAccountingModelName(id))
        : (input.keys.get(id)?.name ?? formatAccountingKeyName(id)),
    values: periods.map((period) => values.get(id)?.get(period) ?? 0),
    total,
    colorIndex,
  }));

  if (hidden.length > 0) {
    const hiddenIds = new Set(hidden.map(([id]) => id));
    series.push({
      id: "__other__",
      label: "Other",
      values: periods.map((period) =>
        input.rows.reduce((sum, row) => {
          const id = input.group === "model" ? row.model : row.keyId;
          return hiddenIds.has(id) && row.day === period
            ? sum + metricValue(row.metrics, input.metric)
            : sum;
        }, 0),
      ),
      total: hidden.reduce((sum, [, value]) => sum + value, 0),
      colorIndex: maxSeries,
    });
  }

  return { periods, series };
}
