import { Link } from "@tanstack/react-router";
import type {
  UsageAccountingKey,
  UsageAccountingMetrics,
  UsageAccountingSourceSummary,
  UsageSummary,
} from "@t3tools/contracts";
import { ChartNoAxesCombinedIcon, ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
  const accounting = useMemo(() => aggregateAccounting(summaries), [summaries]);
  const [metric, setMetric] = useState<AccountingChartMetric>("spend");
  const [group, setGroup] = useState<AccountingChartGroup>("model");
  const trend = useMemo(
    () =>
      buildAccountingTrend({
        rows: accounting.sourceRows,
        keys: accounting.keys,
        metric,
        group,
      }),
    [accounting.keys, accounting.sourceRows, group, metric],
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
                  <h2 className="text-sm font-medium text-foreground">Spend over time</h2>
                  <p className="text-xs text-muted-foreground">
                    Authoritative OpenRouter totals by UTC billing day.
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
  const statusLabel =
    accounting.status === "ok"
      ? "Synced"
      : accounting.status === "cached"
        ? "Cached"
        : accounting.status === "partial"
          ? "Partial"
          : accounting.status === "failed"
            ? "Unavailable"
            : "Not connected";
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
        <h2 className="text-base font-medium text-foreground">Provider billing</h2>
        <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
          Provider-reported spend and tokens by API key and model.
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
  const issues = sources.filter((source) => source.status !== "ok");
  if (issues.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Billing synchronization status">
      {issues.map((source) => (
        <Alert key={source.sourceId} variant={source.status === "failed" ? "error" : "warning"}>
          <CircleAlertIcon aria-hidden />
          <AlertTitle>
            {source.label}: {source.status === "cached" ? "showing cached data" : source.status}
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
  const content =
    kind === "unconfigured"
      ? {
          title: "Connect OpenRouter billing",
          description:
            "Add a management key to see provider-reported spend, tokens, requests, API keys, and models.",
        }
      : kind === "unavailable"
        ? {
            title: "Billing data is unavailable",
            description:
              "Scient could not load OpenRouter analytics and has no cached billing history yet.",
          }
        : {
            title: "No billed activity in this period",
            description:
              "OpenRouter is connected and synchronized. Try a longer date range or verify that the account has activity.",
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
              Connect OpenRouter
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}

function AccountingMetrics({ accounting }: { readonly accounting: AccountingAggregate }) {
  return (
    <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
      <Metric
        label="Spend"
        value={formatUsdPrecise(accounting.totals.totalCostUsd)}
        detail="Selected period"
      />
      <Metric
        label="Tokens"
        value={formatTokens(accounting.totals.totalTokens)}
        detail={`${formatTokens(accounting.totals.promptTokens)} prompt · ${formatTokens(accounting.totals.completionTokens)} completion`}
      />
      <Metric
        label="Requests"
        value={formatCount(accounting.totals.requests)}
        detail="Provider-billed generations"
      />
      <Metric
        label="Credits remaining"
        value={
          accounting.creditsRemainingUsd === null ? "—" : formatUsd(accounting.creditsRemainingUsd)
        }
        detail={
          accounting.creditsRemainingUsd === null ? "Not reported" : "Current account balance"
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        aria-label="Billing chart metric"
        size="compact"
        value={[metric]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "spend" || value === "tokens" || value === "requests")
            onMetricChange(value);
        }}
      >
        <Toggle value="spend">Spend</Toggle>
        <Toggle value="tokens">Tokens</Toggle>
        <Toggle value="requests">Requests</Toggle>
      </ToggleGroup>
      <ToggleGroup
        aria-label="Billing chart grouping"
        size="compact"
        value={[group]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "model" || value === "key") onGroupChange(value);
        }}
      >
        <Toggle value="model">Models</Toggle>
        <Toggle value="key">API keys</Toggle>
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
  return (
    <section className="min-w-0 xl:border-l xl:border-border xl:pl-8">
      <h2 className="text-sm font-medium text-foreground">Top models</h2>
      <p className="text-xs text-muted-foreground">Share of provider-billed spend</p>
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
                <span>{formatTokens(model.metrics.totalTokens)} tokens</span>
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
        <h2 className="text-sm font-medium text-foreground">API keys</h2>
        <p className="text-xs text-muted-foreground">
          Open a key for model, token, and billing-component details.
        </p>
      </div>
      <div className="scient-content-scrollbar overflow-x-auto">
        <div className="hidden min-w-[58rem] grid-cols-[minmax(11rem,1.35fr)_minmax(5rem,.5fr)_minmax(8rem,.75fr)_repeat(2,minmax(5rem,.5fr))_minmax(8rem,.9fr)_2rem] gap-4 border-b border-border px-1 py-2 text-[11px] text-muted-foreground md:grid">
          <span>API key</span>
          <span className="text-right">Spend</span>
          <span>Budget</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Requests</span>
          <span>Top model</span>
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
                {entry.key.disabled ? "Disabled" : "Active"}
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
          {entry.models[0]?.modelName ?? "—"}
        </span>
        <ChevronDownIcon
          className="size-3.5 justify-self-end text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-b border-border/60 bg-muted/20 px-1 py-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Prompt" value={formatTokens(entry.metrics.promptTokens)} />
            <Detail label="Completion" value={formatTokens(entry.metrics.completionTokens)} />
            <Detail label="Reasoning" value={formatTokens(entry.metrics.reasoningTokens)} />
            <Detail label="Cached" value={formatTokens(entry.metrics.cachedTokens)} />
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
  const limit = keyData?.limitUsd;
  const remaining = keyData?.limitRemainingUsd;
  if (limit === null || limit === undefined) {
    return compact ? null : (
      <span className="hidden text-xs text-muted-foreground md:block">No limit</span>
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
      ? "Daily"
      : limitReset === "weekly"
        ? "Weekly"
        : limitReset === "monthly"
          ? "Monthly"
          : "No reset";

  if (compact) {
    return (
      <span className="mt-0.5 block text-[11px] text-muted-foreground md:hidden">
        {boundedRemaining === null
          ? `${formatUsd(budgetLimit)} limit · ${reset}`
          : `${formatUsd(boundedRemaining)} left of ${formatUsd(budgetLimit)} · ${reset}`}
      </span>
    );
  }

  return (
    <span className="hidden min-w-0 md:block">
      <span className="block truncate text-xs font-medium text-foreground tabular-nums">
        {boundedRemaining === null
          ? `${formatUsd(budgetLimit)} limit`
          : `${formatUsd(boundedRemaining)} left`}
      </span>
      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground tabular-nums">
        {boundedRemaining === null ? reset : `of ${formatUsd(budgetLimit)} · ${reset}`}
      </span>
      {used === null || budgetLimit === 0 ? null : (
        <span
          aria-label={`${formatUsd(used)} of ${formatUsd(budgetLimit)} budget used`}
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
  const allDetails: ReadonlyArray<readonly [string, number]> = [
    ["Credits", totals.creditsCostUsd],
    ["BYOK", totals.byokCostUsd],
    ["Upstream", totals.upstreamCostUsd],
    ["Cache", totals.cacheCostUsd],
    ["Data adjustment", totals.dataCostUsd],
    ["Web", totals.webCostUsd],
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
        Cost details
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
