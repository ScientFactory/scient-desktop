import { Link } from "@tanstack/react-router";
import type {
  UsageAccountingKey,
  UsageAccountingMetrics,
  UsageAccountingSourceSummary,
  UsageSummary,
} from "@t3tools/contracts";
import { ChartNoAxesCombinedIcon, ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import {
  formatCount,
  formatDateTimeShort,
  formatTokens,
  formatUsd,
  formatUsdPrecise,
} from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { UsageAccountingTrendChart } from "./UsageAccountingTrendChart";
import {
  addAccountingMetrics,
  aggregateAccounting,
  buildAccountingTrend,
  EMPTY_ACCOUNTING_METRICS,
  type AccountingAggregate,
  type AccountingChartGroup,
  type AccountingChartMetric,
  type AccountingDisplayRow,
  formatAccountingKeyName,
} from "./usageAccountingPresentation";

interface KeySummary {
  readonly keyId: string;
  readonly key: UsageAccountingKey | null;
  readonly metrics: UsageAccountingMetrics;
  readonly models: readonly AccountingDisplayRow[];
}

interface ModelSummary {
  readonly model: string;
  readonly modelName: string;
  readonly metrics: UsageAccountingMetrics;
}

function groupKeys(rows: readonly AccountingDisplayRow[]): readonly KeySummary[] {
  const grouped = new Map<string, KeySummary>();
  for (const row of rows) {
    const current = grouped.get(row.keyId);
    grouped.set(row.keyId, {
      keyId: row.keyId,
      key: row.key ?? current?.key ?? null,
      metrics:
        current === undefined ? row.metrics : addAccountingMetrics(current.metrics, row.metrics),
      models: [...(current?.models ?? []), row].toSorted(
        (a, b) => b.metrics.totalCostUsd - a.metrics.totalCostUsd,
      ),
    });
  }
  return [...grouped.values()].toSorted((a, b) => b.metrics.totalCostUsd - a.metrics.totalCostUsd);
}

function groupModels(rows: readonly AccountingDisplayRow[]): readonly ModelSummary[] {
  const grouped = new Map<string, ModelSummary>();
  for (const row of rows) {
    const current = grouped.get(row.model);
    grouped.set(row.model, {
      model: row.model,
      modelName: row.modelName,
      metrics: addAccountingMetrics(current?.metrics ?? EMPTY_ACCOUNTING_METRICS, row.metrics),
    });
  }
  return [...grouped.values()].toSorted((a, b) => b.metrics.totalCostUsd - a.metrics.totalCostUsd);
}

export function UsageAccountingView({
  summaries,
}: {
  readonly summaries: readonly UsageSummary[];
}) {
  const messages = useMessages();
  const accounting = aggregateAccounting(summaries);
  const [metric, setMetric] = useState<AccountingChartMetric>("spend");
  const [group, setGroup] = useState<AccountingChartGroup>("model");
  const trend = buildAccountingTrend(
    {
      rows: accounting.sourceRows,
      keys: accounting.keys,
      metric,
      group,
    },
    messages,
  );

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <AccountingHeader accounting={accounting} />
      <SourceAlerts sources={accounting.sources} />
      {accounting.state === "unconfigured" ? (
        <AccountingEmptyState kind="unconfigured" />
      ) : accounting.state === "unavailable" ? (
        <AccountingEmptyState kind="unavailable" />
      ) : accounting.state === "empty" ? (
        <AccountingEmptyState kind="empty" />
      ) : (
        <>
          <AccountingMetrics accounting={accounting} />
          <section className="grid min-w-0 gap-7 xl:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8">
            <div className="min-w-0">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-sm font-medium text-foreground">
                    <T>Spend over time</T>
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    <T>Authoritative OpenRouter totals by UTC billing day.</T>
                  </p>
                </div>
                <ChartControls
                  metric={metric}
                  group={group}
                  onMetricChange={setMetric}
                  onGroupChange={setGroup}
                />
              </div>
              <div className="mt-4">
                <UsageAccountingTrendChart trend={trend} metric={metric} />
              </div>
            </div>
            <TopModels
              models={groupModels(accounting.rows)}
              totalSpend={accounting.totals.totalCostUsd}
            />
          </section>
          <ApiKeyBreakdown rows={accounting.rows} />
          <CostDetails totals={accounting.totals} />
        </>
      )}
    </div>
  );
}

function AccountingHeader({ accounting }: { readonly accounting: AccountingAggregate }) {
  const gt = useGT();
  const statusLabel =
    accounting.status === "ok"
      ? gt("Synced", { $context: "billing sync status" })
      : accounting.status === "cached"
        ? gt("Cached", { $context: "billing sync status" })
        : accounting.status === "partial"
          ? gt("Partial", { $context: "billing sync status" })
          : accounting.status === "failed"
            ? gt("Unavailable", { $context: "billing sync status" })
            : gt("Not connected", { $context: "billing sync status" });
  const statusVariant =
    accounting.status === "ok"
      ? "success"
      : accounting.status === "failed"
        ? "error"
        : accounting.status === null
          ? "secondary"
          : "warning";
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-base font-medium text-foreground">
          <T>Provider billing</T>
        </h2>
        <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
          <T>Provider-reported spend and tokens by API key and model.</T>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={statusVariant}>{statusLabel}</Badge>
        {accounting.sources.length > 0 ? (
          <span>{accounting.sources.map((source) => source.label).join(", ")}</span>
        ) : null}
        {accounting.lastSyncedAt === null ? null : (
          <span>· {formatDateTimeShort(accounting.lastSyncedAt)}</span>
        )}
      </div>
    </section>
  );
}

function SourceAlerts({ sources }: { readonly sources: readonly UsageAccountingSourceSummary[] }) {
  const gt = useGT();
  const issues = sources.filter((source) => source.status !== "ok");
  if (issues.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={gt("Billing synchronization status")}>
      {issues.map((source) => (
        <Alert key={source.sourceId} variant={source.status === "failed" ? "error" : "warning"}>
          <CircleAlertIcon aria-hidden />
          <AlertTitle>
            {source.status === "cached"
              ? gt("{source}: showing cached data", { source: source.label })
              : source.status === "partial"
                ? gt("{source}: partial", { source: source.label })
                : source.status === "failed"
                  ? gt("{source}: failed", { source: source.label })
                  : `${source.label}: ${source.status}`}
          </AlertTitle>
          {source.message ? <AlertDescription>{source.message}</AlertDescription> : null}
        </Alert>
      ))}
    </section>
  );
}

function AccountingEmptyState({
  kind,
}: {
  readonly kind: "unconfigured" | "unavailable" | "empty";
}) {
  const gt = useGT();
  const content =
    kind === "unconfigured"
      ? {
          title: gt("Connect OpenRouter billing"),
          description: gt(
            "Add a management key to see provider-reported spend, tokens, requests, API keys, and models.",
          ),
        }
      : kind === "unavailable"
        ? {
            title: gt("Billing data is unavailable"),
            description: gt(
              "Scient could not load OpenRouter analytics and has no cached billing history yet.",
            ),
          }
        : {
            title: gt("No billed activity in this period"),
            description: gt(
              "OpenRouter is connected and synchronized. Try a longer date range or verify that the account has activity.",
            ),
          };
  return (
    <div className="min-h-64 rounded-xl border border-dashed border-border bg-card">
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChartNoAxesCombinedIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{content.title}</EmptyTitle>
          <EmptyDescription>{content.description}</EmptyDescription>
        </EmptyHeader>
        {kind === "unconfigured" ? (
          <EmptyContent>
            <Button render={<Link to="/settings/providers" hash="provider-billing" />}>
              <T>Connect OpenRouter</T>
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}

function AccountingMetrics({ accounting }: { readonly accounting: AccountingAggregate }) {
  const gt = useGT();
  return (
    <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
      <Metric
        label={gt("Spend", { $context: "billing metric" })}
        value={formatUsdPrecise(accounting.totals.totalCostUsd)}
        detail={gt("Selected period")}
      />
      <Metric
        label={gt("Tokens", { $context: "billing metric" })}
        value={formatTokens(accounting.totals.totalTokens)}
        detail={gt("{prompt} prompt · {completion} completion", {
          prompt: formatTokens(accounting.totals.promptTokens),
          completion: formatTokens(accounting.totals.completionTokens),
        })}
      />
      <Metric
        label={gt("Requests", { $context: "billing metric" })}
        value={formatCount(accounting.totals.requests)}
        detail={gt("Provider-billed generations")}
      />
      <Metric
        label={gt("Credits remaining")}
        value={
          accounting.creditsRemainingUsd === null
            ? gt("Unknown", { $context: "credits remaining are not known" })
            : formatUsd(accounting.creditsRemainingUsd)
        }
        detail={
          accounting.creditsRemainingUsd === null
            ? gt("Not reported")
            : gt("Current account balance")
        }
      />
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="min-w-0 bg-card px-4 py-4 sm:px-5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="mt-1 block text-2xl font-semibold text-foreground tabular-nums">
        {value}
      </span>
      <span className="mt-1 block truncate text-[11px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function ChartControls({
  metric,
  group,
  onMetricChange,
  onGroupChange,
}: {
  readonly metric: AccountingChartMetric;
  readonly group: AccountingChartGroup;
  readonly onMetricChange: (value: AccountingChartMetric) => void;
  readonly onGroupChange: (value: AccountingChartGroup) => void;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        aria-label={gt("Billing chart metric")}
        size="compact"
        value={[metric]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "spend" || value === "tokens" || value === "requests")
            onMetricChange(value);
        }}
      >
        <Toggle value="spend">
          <T context="billing metric">Spend</T>
        </Toggle>
        <Toggle value="tokens">
          <T context="billing metric">Tokens</T>
        </Toggle>
        <Toggle value="requests">
          <T context="billing metric">Requests</T>
        </Toggle>
      </ToggleGroup>
      <ToggleGroup
        aria-label={gt("Billing chart grouping")}
        size="compact"
        value={[group]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "model" || value === "key") onGroupChange(value);
        }}
      >
        <Toggle value="model">
          <T context="group billing by model">Models</T>
        </Toggle>
        <Toggle value="key">
          <T context="group billing by API key">API keys</T>
        </Toggle>
      </ToggleGroup>
    </div>
  );
}

function TopModels({
  models,
  totalSpend,
}: {
  readonly models: readonly ModelSummary[];
  readonly totalSpend: number;
}) {
  const gt = useGT();
  return (
    <section className="min-w-0 xl:border-l xl:border-border xl:pl-8">
      <h2 className="text-sm font-medium text-foreground">
        <T>Top models</T>
      </h2>
      <p className="text-xs text-muted-foreground">
        <T>Share of provider-billed spend</T>
      </p>
      <div className="mt-3 flex flex-col">
        {models.slice(0, 5).map((model, index) => {
          const share = totalSpend <= 0 ? 0 : model.metrics.totalCostUsd / totalSpend;
          return (
            <div key={model.model} className="border-t border-border/60 py-3 first:border-t-0">
              <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate font-medium text-foreground">
                  {model.modelName}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatUsdPrecise(model.metrics.totalCostUsd)}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    index === 0
                      ? "bg-blue-500"
                      : index === 1
                        ? "bg-violet-500"
                        : index === 2
                          ? "bg-emerald-500"
                          : index === 3
                            ? "bg-amber-500"
                            : "bg-rose-500",
                  )}
                  style={{ width: `${share * 100}%` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between gap-3 text-[10px] text-muted-foreground">
                <span>
                  {gt("{tokens} tokens", { tokens: formatTokens(model.metrics.totalTokens) })}
                </span>
                <span>{(share * 100).toFixed(1)}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ApiKeyBreakdown({ rows }: { readonly rows: readonly AccountingDisplayRow[] }) {
  const keys = groupKeys(rows);
  return (
    <section className="min-w-0">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-foreground">
          <T>API keys</T>
        </h2>
        <p className="text-xs text-muted-foreground">
          <T>Open a key for model, token, and billing-component details.</T>
        </p>
      </div>
      <div className="scient-content-scrollbar overflow-x-auto">
        <div className="hidden min-w-[58rem] grid-cols-[minmax(11rem,1.35fr)_minmax(5rem,.5fr)_minmax(8rem,.75fr)_repeat(2,minmax(5rem,.5fr))_minmax(8rem,.9fr)_2rem] gap-4 border-b border-border px-1 py-2 text-[11px] text-muted-foreground md:grid">
          <span>
            <T>API key</T>
          </span>
          <span className="text-right">
            <T context="billing metric">Spend</T>
          </span>
          <span>
            <T context="API key spending limit">Budget</T>
          </span>
          <span className="text-right">
            <T context="billing metric">Tokens</T>
          </span>
          <span className="text-right">
            <T context="billing metric">Requests</T>
          </span>
          <span>
            <T>Top model</T>
          </span>
          <span />
        </div>
        {keys.map((entry) => (
          <ApiKeyRow key={entry.keyId} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function ApiKeyRow({ entry }: { readonly entry: KeySummary }) {
  const gt = useGT();
  return (
    <Collapsible>
      <CollapsibleTrigger className="group grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border/60 px-1 py-3 text-left hover:bg-muted/30 md:min-w-[58rem] md:grid-cols-[minmax(11rem,1.35fr)_minmax(5rem,.5fr)_minmax(8rem,.75fr)_repeat(2,minmax(5rem,.5fr))_minmax(8rem,.9fr)_2rem] md:gap-4">
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {entry.key?.name ?? formatAccountingKeyName(entry.keyId)}
            </span>
            {entry.key === null ? null : (
              <Badge variant={entry.key.disabled ? "secondary" : "success"}>
                {entry.key.disabled
                  ? gt("Disabled", { $context: "API key state" })
                  : gt("Active", { $context: "API key state" })}
              </Badge>
            )}
          </span>
          <KeyBudget compact keyData={entry.key} />
        </span>
        <span className="text-right text-sm font-medium tabular-nums">
          {formatUsdPrecise(entry.metrics.totalCostUsd)}
        </span>
        <KeyBudget keyData={entry.key} />
        <span className="hidden text-right text-xs text-muted-foreground tabular-nums md:block">
          {formatTokens(entry.metrics.totalTokens)}
        </span>
        <span className="hidden text-right text-xs text-muted-foreground tabular-nums md:block">
          {formatCount(entry.metrics.requests)}
        </span>
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
          {entry.models[0]?.modelName ?? gt("Unknown", { $context: "model name is not known" })}
        </span>
        <ChevronDownIcon
          className="size-3.5 justify-self-end text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-b border-border/60 bg-muted/20 px-1 py-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Detail
              label={gt("Prompt", { $context: "prompt tokens" })}
              value={formatTokens(entry.metrics.promptTokens)}
            />
            <Detail
              label={gt("Completion", { $context: "completion tokens" })}
              value={formatTokens(entry.metrics.completionTokens)}
            />
            <Detail
              label={gt("Reasoning", { $context: "reasoning tokens" })}
              value={formatTokens(entry.metrics.reasoningTokens)}
            />
            <Detail
              label={gt("Cached", { $context: "cached tokens" })}
              value={formatTokens(entry.metrics.cachedTokens)}
            />
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {entry.models.map((model) => (
              <div
                key={model.model}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 text-xs"
              >
                <span className="truncate text-foreground">{model.modelName}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatTokens(model.metrics.totalTokens)}
                </span>
                <span className="font-medium tabular-nums">
                  {formatUsdPrecise(model.metrics.totalCostUsd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function KeyBudget({
  compact = false,
  keyData,
}: {
  readonly compact?: boolean;
  readonly keyData: UsageAccountingKey | null;
}) {
  const gt = useGT();
  const limit = keyData?.limitUsd;
  const remaining = keyData?.limitRemainingUsd;
  if (limit === null || limit === undefined) {
    return compact ? null : (
      <span className="hidden text-xs text-muted-foreground md:block">
        <T>No limit</T>
      </span>
    );
  }

  const budgetLimit = Math.max(0, limit);
  const boundedRemaining =
    remaining === null || remaining === undefined
      ? null
      : Math.min(budgetLimit, Math.max(0, remaining));
  const used = boundedRemaining === null ? null : Math.max(0, budgetLimit - boundedRemaining);
  const usedPercent = used === null || budgetLimit === 0 ? 0 : (used / budgetLimit) * 100;
  const limitReset = keyData?.limitReset;
  const reset =
    limitReset === "daily"
      ? gt("Daily", { $context: "budget resets every day" })
      : limitReset === "weekly"
        ? gt("Weekly", { $context: "budget resets every week" })
        : limitReset === "monthly"
          ? gt("Monthly", { $context: "budget resets every month" })
          : gt("No reset");

  if (compact) {
    return (
      <span className="mt-0.5 block text-[11px] text-muted-foreground md:hidden">
        {boundedRemaining === null
          ? gt("{limit} limit · {reset}", { limit: formatUsd(budgetLimit), reset })
          : gt("{remaining} left of {limit} · {reset}", {
              remaining: formatUsd(boundedRemaining),
              limit: formatUsd(budgetLimit),
              reset,
            })}
      </span>
    );
  }

  return (
    <span className="hidden min-w-0 md:block">
      <span className="block truncate text-xs font-medium text-foreground tabular-nums">
        {boundedRemaining === null
          ? gt("{limit} limit", { limit: formatUsd(budgetLimit) })
          : gt("{remaining} left", { remaining: formatUsd(boundedRemaining) })}
      </span>
      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground tabular-nums">
        {boundedRemaining === null
          ? reset
          : gt("of {limit} · {reset}", { limit: formatUsd(budgetLimit), reset })}
      </span>
      {used === null || budgetLimit === 0 ? null : (
        <span
          aria-label={gt("{used} of {limit} budget used", {
            used: formatUsd(used),
            limit: formatUsd(budgetLimit),
          })}
          aria-valuemax={budgetLimit}
          aria-valuemin={0}
          aria-valuenow={used}
          className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${usedPercent}%` }}
          />
        </span>
      )}
    </span>
  );
}

function CostDetails({ totals }: { readonly totals: UsageAccountingMetrics }) {
  const gt = useGT();
  const allDetails: ReadonlyArray<readonly [string, number]> = [
    [gt("Credits", { $context: "billing cost component" }), totals.creditsCostUsd],
    ["BYOK", totals.byokCostUsd],
    [gt("Upstream", { $context: "billing cost component" }), totals.upstreamCostUsd],
    [gt("Cache", { $context: "billing cost component" }), totals.cacheCostUsd],
    [gt("Data adjustment", { $context: "billing cost component" }), totals.dataCostUsd],
    [gt("Web", { $context: "billing cost component: web search" }), totals.webCostUsd],
  ];
  const details = allDetails.filter((entry) => entry[1] !== 0);
  if (details.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDownIcon
          className="size-3.5 transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
        <T>Cost details</T>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-3 grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
          {details.map(([label, value]) => (
            <Detail key={label} label={label} value={formatUsdPrecise(value)} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="mt-0.5 block truncate text-xs font-medium text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}
