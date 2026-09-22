import {
  UsageAccountingSourceId,
  UsageDay,
  type UsageAccountingSourceSummary,
  type UsageSummary,
} from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UsageAccountingView } from "./UsageAccountingView";
import {
  aggregateAccounting,
  buildAccountingTrend,
  formatAccountingKeyName,
  formatAccountingModelName,
  groupPiUsage,
} from "./usageAccountingPresentation";

const metrics = {
  requests: 2,
  totalTokens: 100,
  promptTokens: 80,
  completionTokens: 20,
  reasoningTokens: 5,
  cachedTokens: 30,
  totalCostUsd: 0.1,
  creditsCostUsd: 0.1,
  byokCostUsd: 0,
  upstreamCostUsd: 0.08,
  cacheCostUsd: 0.01,
  dataCostUsd: 0,
  webCostUsd: 0.01,
};

function source(id: string): UsageAccountingSourceSummary {
  return {
    sourceId: UsageAccountingSourceId.make(id),
    kind: "openrouter",
    label: id,
    status: "ok",
    lastSyncedAt: "2026-09-20T12:00:00Z",
    message: null,
    truncated: false,
    totalCreditsUsd: 10,
    totalUsageUsd: 2,
    keys: [
      {
        id: "hash-a",
        name: "Scient",
        disabled: false,
        limitUsd: null,
        limitRemainingUsd: null,
        usageUsd: 0,
        usageDailyUsd: 0,
        usageWeeklyUsd: 0,
        usageMonthlyUsd: 0,
        byokUsageUsd: 0,
        expiresAt: null,
      },
    ],
    rows: [{ day: UsageDay.make("2026-09-20"), keyId: "hash-a", model: "z-ai/glm", metrics }],
  };
}

function summary(accountingSource: UsageAccountingSourceSummary): UsageSummary {
  return {
    contractVersion: 6,
    readAt: "2026-09-20T12:00:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-20"),
    untilDay: UsageDay.make("2026-09-20"),
    buckets: [],
    sources: [],
    pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
    accounting: { sources: [accountingSource], pi: [] },
    scanDurationMs: 0,
  };
}

describe("usage accounting aggregation", () => {
  it("deduplicates one OpenRouter account configured on two environments", () => {
    const result = aggregateAccounting([summary(source("first")), summary(source("second"))]);
    expect(result.sources).toHaveLength(1);
    expect(result.totals.totalCostUsd).toBe(0.1);
    expect(result.rows).toHaveLength(1);
  });

  it("prefers the newest equally healthy copy of one OpenRouter account", () => {
    const older = source("older");
    const newer = {
      ...source("newer"),
      lastSyncedAt: "2026-09-20T13:00:00Z",
      rows: [
        {
          ...source("newer").rows[0]!,
          metrics: { ...metrics, totalCostUsd: 0.2 },
        },
      ],
    };
    const result = aggregateAccounting([summary(older), summary(newer)]);

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.sourceId).toBe(newer.sourceId);
    expect(result.totals.totalCostUsd).toBe(0.2);
  });

  it("sums distinct models for the same API key", () => {
    const first = source("first");
    const second = {
      ...first,
      rows: [
        ...first.rows,
        { day: UsageDay.make("2026-09-20"), keyId: "hash-a", model: "deepseek/v3", metrics },
      ],
    };
    const result = aggregateAccounting([summary(second)]);
    expect(result.totals.totalCostUsd).toBe(0.2);
    expect(result.rows).toHaveLength(2);
  });

  it("treats local pi activity as independent from provider connection state", () => {
    const value = summary(source("first"));
    const summaryWithPi = {
      ...value,
      accounting: {
        sources: [],
        pi: [
          {
            day: UsageDay.make("2026-09-20"),
            connectionId: "connection-a",
            connectionName: "Personal OpenRouter",
            provider: "openrouter",
            model: "z-ai/glm",
            modelName: "GLM",
            totals: {
              uncachedInputTokens: 100,
              cachedInputTokens: 10,
              cacheCreationTokens: 0,
              outputTokens: 20,
              reasoningTokens: 5,
            },
            estimatedCostUsd: 0.0011,
            records: 1,
            sessions: 1,
            generations: 1,
          },
        ],
      },
    };
    const result = aggregateAccounting([summaryWithPi]);
    expect(result.state).toBe("unconfigured");
    expect(result.totals.totalTokens).toBe(0);
    expect(result.pi[0]).toMatchObject({
      connectionName: "Personal OpenRouter",
      modelName: "GLM",
      cost: 0.0011,
    });

    const markup = renderToStaticMarkup(
      createElement(UsageAccountingView, {
        summaries: [
          {
            ...summaryWithPi,
            accounting: { ...summaryWithPi.accounting, sources: [source("first")] },
          },
        ],
      }),
    );
    expect(markup).not.toContain("Activity recorded by Scient");
    expect(markup).not.toContain("Local estimate");
    expect(markup).not.toContain("Personal OpenRouter");
  });

  it("reports unknown credit balance as null instead of a false zero", () => {
    const withoutCredits = {
      ...source("first"),
      totalCreditsUsd: null,
      totalUsageUsd: null,
    };
    expect(aggregateAccounting([summary(withoutCredits)]).creditsRemainingUsd).toBeNull();
  });

  it("shows provider key budgets with their reset period", () => {
    const value = source("first");
    const withBudget = {
      ...value,
      keys: [
        {
          ...value.keys[0]!,
          limitUsd: 10,
          limitRemainingUsd: 7,
          limitReset: "monthly" as const,
          includeByokInLimit: true,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(UsageAccountingView, { summaries: [summary(withBudget)] }),
    );

    expect(markup).toContain("Budget");
    expect(markup).toContain("$7.00 left");
    expect(markup).toContain("of $10.00 · Monthly");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('class="scient-content-scrollbar overflow-x-auto"');
  });

  it("builds ranked daily model and key line series without losing periods", () => {
    const value = source("first");
    const secondDay = {
      ...value.rows[0]!,
      day: UsageDay.make("2026-09-21"),
      model: "deepseek/v3",
      metrics: { ...metrics, totalCostUsd: 0.4 },
    };
    const result = aggregateAccounting([summary({ ...value, rows: [...value.rows, secondDay] })]);
    const byModel = buildAccountingTrend({
      rows: result.sourceRows,
      keys: result.keys,
      metric: "spend",
      group: "model",
    });
    expect(byModel.periods).toEqual(["2026-09-20", "2026-09-21"]);
    expect(byModel.series.map((series) => [series.label, series.values])).toEqual([
      ["V3", [0, 0.4]],
      ["GLM", [0.1, 0]],
    ]);
    const byKey = buildAccountingTrend({
      rows: result.sourceRows,
      keys: result.keys,
      metric: "tokens",
      group: "key",
    });
    expect(byKey.series[0]).toMatchObject({ label: "Scient", values: [100, 100] });
  });

  it("formats provider identifiers as readable fallback labels", () => {
    expect(formatAccountingModelName("meta/muse-spark-1.3-20260902")).toBe("Muse Spark 1.3");
    expect(formatAccountingModelName("z-ai/glm-5.3-flash-20260826")).toBe("GLM 5.3 Flash");
    expect(formatAccountingKeyName("Key …Scient")).toBe("Scient");
    expect(formatAccountingKeyName("Alpha try")).toBe("Alpha try");
    expect(formatAccountingKeyName("0123456789abcdef0123456789abcdef")).toBe("API key …abcdef");
  });

  it("groups pi rows while retaining friendly labels", () => {
    const rows = groupPiUsage([
      {
        day: UsageDay.make("2026-09-20"),
        connectionId: "connection-a",
        connectionName: "Personal OpenRouter",
        provider: "openrouter",
        model: "z-ai/glm",
        modelName: "GLM",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 20,
          reasoningTokens: 5,
        },
        estimatedCostUsd: 0.001,
        records: 1,
        sessions: 1,
        generations: 1,
      },
      {
        day: UsageDay.make("2026-09-21"),
        connectionId: "connection-a",
        connectionName: "Personal OpenRouter",
        provider: "openrouter",
        model: "z-ai/glm",
        modelName: "GLM",
        totals: {
          uncachedInputTokens: 50,
          cachedInputTokens: 10,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 2,
        },
        estimatedCostUsd: 0.002,
        records: 2,
        sessions: 1,
        generations: 2,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionName: "Personal OpenRouter",
      modelName: "GLM",
      cost: 0.003,
      records: 3,
      totals: { uncachedInputTokens: 150, cachedInputTokens: 10, outputTokens: 30 },
    });
  });
});
