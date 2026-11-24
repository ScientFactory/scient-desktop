import type {
  ProviderConnectionAccount,
  ScientAgentSettings,
  ServerProviderModel,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ServerProviderUsageWindowStatus,
} from "@t3tools/contracts";
import type {
  ProviderUsageReader,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { piUsageFormat } from "@t3tools/provider-pi/server/usage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { scientAgentTarget } from "./ScientAgentTarget.ts";

// Only the fields Scient reads from `scient-agent usage --json`; the agent adds more over time.
const UsageScope = Schema.Struct({
  modelId: Schema.optional(Schema.String),
  tier: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.String),
  shared: Schema.optional(Schema.Boolean),
});
const UsageLimit = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  scope: Schema.optional(UsageScope),
  window: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      durationMs: Schema.optional(Schema.Finite),
      resetsAt: Schema.optional(Schema.Finite),
    }),
  ),
  amount: Schema.Struct({
    used: Schema.optional(Schema.Finite),
    limit: Schema.optional(Schema.Finite),
    remaining: Schema.optional(Schema.Finite),
    usedFraction: Schema.optional(Schema.Finite),
    remainingFraction: Schema.optional(Schema.Finite),
    unit: Schema.String,
  }),
  status: Schema.optional(Schema.String),
});
const UsageReport = Schema.Struct({
  provider: Schema.String,
  fetchedAt: Schema.optional(Schema.Finite),
  limits: Schema.Array(UsageLimit),
  metadata: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
      quotaSource: Schema.optional(Schema.String),
    }),
  ),
});
const AccountWithoutUsage = Schema.Struct({ provider: Schema.String });
const UsageOutput = Schema.Struct({
  reports: Schema.Array(UsageReport),
  accountsWithoutUsage: Schema.optional(Schema.Array(AccountWithoutUsage)),
});
const decodeUsageOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageOutput));

type UsageLimit = typeof UsageLimit.Type;
type UsageReport = typeof UsageReport.Type;

/** The agent's own precedence: explicit fraction, used/limit, percent used, inverted remaining. */
function usedFraction(amount: UsageLimit["amount"]): number | undefined {
  if (amount.usedFraction !== undefined) return amount.usedFraction;
  if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0)
    return amount.used / amount.limit;
  if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
  if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
  if (amount.remaining === 0 && (amount.limit === undefined || amount.limit > 0)) return 1;
  return undefined;
}

function limitStatus(
  limit: UsageLimit,
  fraction: number | undefined,
): ServerProviderUsageWindowStatus {
  if (
    limit.status === "ok" ||
    limit.status === "warning" ||
    limit.status === "exhausted" ||
    limit.status === "unknown"
  ) {
    return limit.status;
  }
  if (fraction === undefined) return "unknown";
  if (fraction >= 1) return "exhausted";
  if (fraction >= 0.8) return "warning";
  return "ok";
}

const HOUR_MS = 60 * 60 * 1000;
function windowKind(durationMs: number | undefined): ServerProviderUsageWindow["kind"] {
  if (durationMs === undefined) return "other";
  if (durationMs <= 24 * HOUR_MS) return "session";
  if (durationMs <= 8 * 24 * HOUR_MS) return "weekly";
  if (durationMs >= 28 * 24 * HOUR_MS) return "monthly";
  return "other";
}

const normalizeToken = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-");

const bareModelId = (slug: string) => {
  const slash = slug.indexOf("/");
  return (slash >= 0 ? slug.slice(slash + 1) : slug).toLowerCase();
};

function matchModelId(slug: string, modelId: string): boolean {
  const bare = bareModelId(slug);
  const target = bareModelId(modelId);
  if (bare === target || slug.toLowerCase() === modelId.trim().toLowerCase()) return true;
  const normalizedTarget = normalizeToken(target);
  return normalizedTarget.length > 0 && normalizeToken(bare).includes(normalizedTarget);
}

function limitWindowLabel(limit: UsageLimit, provider: string): string {
  const windowLabel = limit.window?.label.trim();
  const fullLabel = limit.label.trim();
  if (!windowLabel) return fullLabel;
  if (!fullLabel || fullLabel.toLowerCase() === windowLabel.toLowerCase()) return windowLabel;
  const qualifier = fullLabel.match(/\([^)]+\)$/u)?.[0];
  if (qualifier && !windowLabel.toLowerCase().includes(qualifier.toLowerCase())) {
    if (fullLabel.toLowerCase().includes(windowLabel.toLowerCase())) {
      return `${windowLabel} ${qualifier}`;
    }
    return `${fullLabel} · ${windowLabel}`;
  }
  if (
    (provider === "google-antigravity" || provider === "antigravity-cli") &&
    !fullLabel.toLowerCase().includes(windowLabel.toLowerCase())
  ) {
    return `${fullLabel} · ${windowLabel}`;
  }
  return windowLabel;
}

function providerIdsForReport(
  provider: string,
  accounts: ReadonlyArray<ProviderConnectionAccount> | undefined,
): ReadonlyArray<string> {
  const ids = new Set<string>([provider]);
  for (const account of accounts ?? []) {
    if (account.sameAccountAs === provider) ids.add(account.id);
  }
  return [...ids];
}

function resolveLimitScope(
  report: UsageReport,
  limit: UsageLimit,
  providerModels: ReadonlyArray<string>,
): { readonly modelIds?: ReadonlyArray<string>; readonly gating: boolean } {
  const scope = limit.scope;
  const windowId = scope?.windowId ?? limit.window?.id;

  if (report.provider === "anthropic") {
    if (limit.id === "anthropic:extra" || windowId === "extra") {
      return { gating: false };
    }
    if (scope?.modelId) {
      return {
        modelIds: providerModels.filter((slug) => matchModelId(slug, scope.modelId!)),
        gating: true,
      };
    }
    if (scope?.shared === true) {
      return { gating: true };
    }
    const tier =
      scope?.tier?.trim().toLowerCase() ??
      (limit.id.startsWith("anthropic:7d:")
        ? limit.id.slice("anthropic:7d:".length).trim().toLowerCase()
        : undefined);
    if (tier) {
      const isFableOrMythos = tier === "fable" || tier === "mythos";
      const otherTier = tier === "fable" ? "mythos" : "fable";
      const otherTierHasOwnWindow = report.limits.some(
        (entry) =>
          entry.scope?.shared !== true &&
          (entry.scope?.tier?.trim().toLowerCase() === otherTier ||
            entry.id === `anthropic:7d:${otherTier}`),
      );
      const matched = providerModels.filter((slug) => {
        const bare = bareModelId(slug);
        return (
          normalizeToken(bare).includes(normalizeToken(tier)) ||
          (isFableOrMythos && !otherTierHasOwnWindow && bare.includes(otherTier))
        );
      });
      const gating =
        !isFableOrMythos ||
        (limit.window?.resetsAt !== undefined &&
          Number.isFinite(limit.window.resetsAt) &&
          (limit.status === "exhausted" || (usedFraction(limit.amount) ?? 0) >= 1));
      return { modelIds: matched, gating };
    }
    if (limit.id === "anthropic:5h" || limit.id === "anthropic:7d") {
      return { gating: true };
    }
    return { gating: false };
  }

  if (report.provider === "openai-codex") {
    const hasPlanWindows = report.limits.some(
      (entry) => entry.id === "openai-codex:primary" || entry.id === "openai-codex:secondary",
    );
    if (limit.id === "openai-codex:spend-cap" || scope?.tier === "credits") {
      if (hasPlanWindows) return { gating: false };
      const hasSparkModels = providerModels.some((slug) => bareModelId(slug).includes("spark"));
      return hasSparkModels
        ? {
            modelIds: providerModels.filter((slug) => !bareModelId(slug).includes("spark")),
            gating: true,
          }
        : { gating: true };
    }
    const isAdditionalMeter =
      scope?.modelId !== undefined ||
      (scope?.tier !== undefined && scope.tier !== "credits") ||
      /^openai-codex:[^:]+:(?:primary|secondary)$/u.test(limit.id);
    if (isAdditionalMeter) {
      const slugToken = (scope?.tier ?? limit.id.split(":")[1] ?? "").trim().toLowerCase();
      const probe = `${slugToken} ${scope?.modelId ?? ""}`.toLowerCase();
      const isSpark = probe.includes("spark") || probe.includes("bengalfox");
      const matched = providerModels.filter((slug) =>
        isSpark
          ? bareModelId(slug).includes("spark")
          : scope?.modelId
            ? matchModelId(slug, scope.modelId)
            : normalizeToken(bareModelId(slug)).includes(normalizeToken(slugToken)),
      );
      return { modelIds: matched, gating: isSpark };
    }
    const hasSparkModels = providerModels.some((slug) => bareModelId(slug).includes("spark"));
    return hasSparkModels
      ? {
          modelIds: providerModels.filter((slug) => !bareModelId(slug).includes("spark")),
          gating: true,
        }
      : { gating: true };
  }

  if (report.provider === "google-antigravity" || report.provider === "antigravity-cli") {
    const counter = limit.id.split(":")[1]?.toLowerCase();
    const counters = new Set(report.limits.map((entry) => entry.id.split(":")[1]?.toLowerCase()));
    const hasArgonSplit =
      report.metadata?.quotaSource === "retrieveUserQuotaSummary" || counters.has("google-argon");
    const modelIds = providerModels.filter((slug) => {
      const bare = bareModelId(slug);
      const modelCounter = bare.includes("gemini")
        ? bare.includes("argon") && hasArgonSplit
          ? "google-argon"
          : "google"
        : bare.includes("claude")
          ? "anthropic"
          : /(?:^|[-/])(?:gpt|o[134])(?:[-.]|$)/u.test(bare)
            ? "openai"
            : undefined;
      return (
        modelCounter !== undefined &&
        (modelCounter === counter ||
          (counter === "default" && modelCounter !== "google-argon" && !counters.has(modelCounter)))
      );
    });
    return { modelIds, gating: true };
  }

  if (scope?.modelId) {
    return {
      modelIds: providerModels.filter((slug) => matchModelId(slug, scope.modelId!)),
      gating: true,
    };
  }
  if (windowId === "extra" || windowId === "concurrency") {
    return { gating: false };
  }
  if (scope?.shared === true) {
    return { gating: true };
  }
  if (report.provider === "google-gemini-cli" && scope?.tier) {
    const tierToken = normalizeToken(scope.tier);
    return {
      modelIds: providerModels.filter((slug) =>
        normalizeToken(bareModelId(slug)).includes(tierToken),
      ),
      gating: true,
    };
  }
  return { gating: true };
}

/**
 * The agent's usage report as usage bars, one per window of each signed-in model account. Each
 * window preserves runtime scope, availability status, account identity, and fetch freshness.
 */
export function scientAgentUsageLimits(input: {
  readonly output: typeof UsageOutput.Type;
  readonly accounts: ReadonlyArray<ProviderConnectionAccount> | undefined;
  readonly models?: ReadonlyArray<Pick<ServerProviderModel, "slug">> | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const reportsPerProvider = new Map<string, number>();
  for (const report of input.output.reports)
    reportsPerProvider.set(report.provider, (reportsPerProvider.get(report.provider) ?? 0) + 1);
  const seen = new Map<string, number>();
  const unknownProviders = new Set<string>();
  const windows: ServerProviderUsageWindow[] = [];
  const allModelSlugs = (input.models ?? []).map((model) => model.slug);

  for (const report of input.output.reports) {
    const index = seen.get(report.provider) ?? 0;
    seen.set(report.provider, index + 1);
    const accountName =
      input.accounts?.find((account) => account.id === report.provider)?.name ?? report.provider;
    // Several accounts of one provider are told apart by their email.
    const email = report.metadata?.email?.trim();
    const account =
      (reportsPerProvider.get(report.provider) ?? 0) > 1 && email
        ? `${accountName} (${email})`
        : accountName;
    const accountId = `${report.provider}#${index + 1}`;

    const providerIds = providerIdsForReport(report.provider, input.accounts);
    const providerIdSet = new Set(providerIds);
    const providerModels = allModelSlugs.filter((slug) =>
      providerIdSet.has(slug.split("/", 1)[0] ?? ""),
    );
    const fetchedAt =
      report.fetchedAt !== undefined && Number.isFinite(report.fetchedAt) && report.fetchedAt > 0
        ? DateTime.formatIso(DateTime.makeUnsafe(report.fetchedAt))
        : undefined;

    const readings = report.limits.map((limit) => {
      const fraction = usedFraction(limit.amount);
      return {
        limit,
        fraction,
        status: limitStatus(limit, fraction),
        scope: resolveLimitScope(report, limit, providerModels),
      };
    });
    const missingMeters = readings.filter(
      ({ fraction, status, scope }) =>
        fraction === undefined && status !== "exhausted" && scope.gating,
    );
    if (
      readings.every(({ fraction, status }) => fraction === undefined && status !== "exhausted")
    ) {
      for (const id of providerIds) unknownProviders.add(id);
    }

    for (const { limit, fraction, status, scope } of readings) {
      if (fraction === undefined && status !== "exhausted") continue;
      const durationMs = limit.window?.durationMs;
      const resetsAt = limit.window?.resetsAt;
      const hasMissingReading = missingMeters.some(
        ({ scope: meter }) =>
          meter.modelIds === undefined ||
          meter.modelIds.some((id) => scope.modelIds === undefined || scope.modelIds.includes(id)),
      );
      windows.push({
        id: index === 0 ? limit.id : `${limit.id}#${index + 1}`,
        kind: windowKind(durationMs),
        label: `${account} · ${limitWindowLabel(limit, report.provider)}`,
        providerIds: [...providerIds],
        ...(scope.modelIds !== undefined ? { modelIds: [...scope.modelIds] } : {}),
        accountId,
        status: status !== "exhausted" && hasMissingReading ? "unknown" : status,
        ...(scope.gating ? {} : { gating: false }),
        ...(fetchedAt !== undefined ? { fetchedAt } : {}),
        usedPercent: fraction === undefined ? 100 : clampPercent(fraction * 100),
        ...(resetsAt !== undefined && Number.isFinite(resetsAt)
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt)) }
          : {}),
        ...(durationMs !== undefined && durationMs > 0
          ? { windowDurationMins: Math.round(durationMs / 60_000) }
          : {}),
      });
    }
  }

  const markUnknown = (provider: string) => {
    for (const id of providerIdsForReport(provider, input.accounts)) {
      unknownProviders.add(id);
    }
  };
  for (const entry of input.output.accountsWithoutUsage ?? []) {
    markUnknown(entry.provider);
  }
  for (const account of input.accounts ?? []) {
    if (!account.connected || account.kind !== "account") continue;
    const canonical = account.sameAccountAs ?? account.id;
    const expectedCount = account.emails?.length ?? 0;
    if (expectedCount > (reportsPerProvider.get(canonical) ?? 0)) {
      markUnknown(canonical);
      unknownProviders.add(account.id);
    }
  }

  const base = makeUsageLimits({ checkedAt: input.checkedAt, windows });
  return unknownProviders.size > 0
    ? { ...base, unknownProviderIds: [...unknownProviders].toSorted() }
    : base;
}

/**
 * Reads usage limits for the agent's signed-in accounts; undefined without one. A failed read
 * keeps the last bars. The agent caches each provider's answer, so this is cheap to repeat.
 */
export const readScientAgentUsageLimits = Effect.fn("readScientAgentUsageLimits")(function* (
  run: (args: ReadonlyArray<string>) => Effect.Effect<string, { readonly message: string }>,
  accounts: ReadonlyArray<ProviderConnectionAccount> | undefined,
  models?: ReadonlyArray<Pick<ServerProviderModel, "slug">>,
) {
  if (!accounts?.some((account) => account.connected)) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* run(["usage", "--json"]).pipe(
    Effect.flatMap(decodeUsageOutput),
    Effect.map((output) => scientAgentUsageLimits({ output, accounts, models, checkedAt })),
    Effect.map((limits) => (limits.windows.length > 0 ? limits : undefined)),
    Effect.orElseSucceed(() => makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })),
  );
});

// The agent writes Pi's format; its records are Scient Agent's own, never Pi's.
const asScientAgent = (record: UsageRecord): UsageRecord => ({
  ...record,
  provider: "scient",
  dedupeKey: record.dedupeKey === null ? null : `scient:${record.dedupeKey}`,
});
const pi = piUsageFormat as TranscriptUsageFormat<unknown>;
// Calls outside the conversation (prompt predictions, titles, cache warming) are `model_usage`
// entries, which carry the fields of Pi's `usage` entry.
const asPiEntry = (entry: unknown): unknown =>
  typeof entry === "object" && entry !== null && "type" in entry && entry.type === "model_usage"
    ? { ...entry, type: "usage" }
    : entry;
// The marker tells a scan saved before side calls were counted, which the cache re-reads whole.
const ScientAgentScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  sideCalls: Schema.Literal(true),
});
const isScientAgentScanState = Schema.is(ScientAgentScanState);
/** Whether a cached scan's state comes from this reader, which counts side calls. */
export const scientAgentScanStateIsCurrent = (state: unknown): boolean =>
  isScientAgentScanState(state);
const scientAgentUsageFormat: TranscriptUsageFormat<unknown> = {
  ...pi,
  state: {
    initial: () => ({ sessionId: "", sideCalls: true }),
    schema: ScientAgentScanState as Schema.Codec<unknown>,
  },
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return pi.parseProjected(asPiEntry(parsed), state).map(asScientAgent);
  },
  parseProjected: (projected, state) =>
    pi.parseProjected(asPiEntry(projected), state).map(asScientAgent),
};

/** Token and cost history from the conversations Scient runs with the agent. */
export const scientAgentUsageReader: ProviderUsageReader<
  ScientAgentSettings,
  Path.Path | ServerConfig
> = {
  kind: "transcripts",
  provider: "scient",
  format: scientAgentUsageFormat,
  directories: Effect.fn("scientAgentUsageReader.directories")(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    return [{ dir: path.join(config.stateDir, `${scientAgentTarget.stateNamespace}-sessions`) }];
  }),
};
