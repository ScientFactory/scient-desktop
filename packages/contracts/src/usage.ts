import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageAccountingSourceId } from "./usageAccountingSourceId.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly.
 * Adding providers or other array-element variants is additive: unknown entries
 * are skipped on decode and do not require a version bump.
 */
export const USAGE_CONTRACT_VERSION = 6 as const;

/**
 * Oldest {@link UsageSummary} version a current client will still merge.
 *
 * v5 added `grok`; v6 adds `pi` and optional provider accounting, plus the
 * `cursor`/`opencode`/`antigravity` local-history providers and optional source
 * attribution. v4 Claude/Codex buckets remain valid, so mixed-version
 * environments keep those totals instead of treating every older server as
 * stale.
 */
export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCategoryCost = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type UsageCategoryCost = typeof UsageCategoryCost.Type;

export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  categoryCostUsd: Schema.optional(UsageCategoryCost),
  fastCostUsd: Schema.optional(Schema.Number),
  ultrafastCostUsd: Schema.optional(Schema.Number),
  speedPremiumUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped.
   */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  /**
   * Buckets also carry per-bucket session counts, but a session spans days and
   * models, so summing those overcounts; this is the figure clients should
   * total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
  action: Schema.optionalKey(Schema.Literal("enableCursorKeychain")),
  /**
   * Present when this source answered from its cache while a slow refresh (an
   * account API, for example) runs. Repeat the request with `awaitRefresh` to
   * get the refreshed source.
   */
  refreshing: Schema.optionalKey(Schema.Literal(true)),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

/** Provider-billed metrics returned by OpenRouter's Analytics API. */
export const UsageAccountingMetrics = Schema.Struct({
  requests: NonNegativeInt,
  totalTokens: NonNegativeInt,
  promptTokens: NonNegativeInt,
  completionTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  cachedTokens: NonNegativeInt,
  totalCostUsd: Schema.Number,
  creditsCostUsd: Schema.Number,
  byokCostUsd: Schema.Number,
  upstreamCostUsd: Schema.Number,
  cacheCostUsd: Schema.Number,
  dataCostUsd: Schema.Number,
  webCostUsd: Schema.Number,
});
export type UsageAccountingMetrics = typeof UsageAccountingMetrics.Type;

export const UsageAccountingKey = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  disabled: Schema.Boolean,
  limitUsd: Schema.NullOr(Schema.Number),
  limitRemainingUsd: Schema.NullOr(Schema.Number),
  limitReset: Schema.optional(Schema.NullOr(Schema.Literals(["daily", "weekly", "monthly"]))),
  includeByokInLimit: Schema.optional(Schema.Boolean),
  usageUsd: Schema.Number,
  usageDailyUsd: Schema.Number,
  usageWeeklyUsd: Schema.Number,
  usageMonthlyUsd: Schema.Number,
  byokUsageUsd: Schema.Number,
  expiresAt: Schema.NullOr(Schema.String),
});
export type UsageAccountingKey = typeof UsageAccountingKey.Type;

/** One authoritative `(UTC day, API key, model)` OpenRouter cell. */
export const UsageAccountingRow = Schema.Struct({
  day: UsageDay,
  keyId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  /** Provider-authored display name when the model catalog can resolve the analytics slug. */
  modelName: Schema.optional(TrimmedNonEmptyString),
  metrics: UsageAccountingMetrics,
});
export type UsageAccountingRow = typeof UsageAccountingRow.Type;

export const UsageAccountingSourceStatus = Schema.Literals(["ok", "cached", "partial", "failed"]);
export type UsageAccountingSourceStatus = typeof UsageAccountingSourceStatus.Type;
export const UsageAccountingSourceSummary = Schema.Struct({
  sourceId: UsageAccountingSourceId,
  kind: Schema.Literal("openrouter"),
  label: TrimmedNonEmptyString,
  status: UsageAccountingSourceStatus,
  lastSyncedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  totalCreditsUsd: Schema.NullOr(Schema.Number),
  totalUsageUsd: Schema.NullOr(Schema.Number),
  keys: Schema.Array(UsageAccountingKey),
  rows: Schema.Array(UsageAccountingRow),
});
export type UsageAccountingSourceSummary = typeof UsageAccountingSourceSummary.Type;

/** Local pi execution truth. Cost is explicitly an estimate, never billed spend. */
export const PiUsageRow = Schema.Struct({
  day: UsageDay,
  connectionId: TrimmedNonEmptyString,
  /** Friendly labels resolved from current custom-model settings when available. */
  connectionName: Schema.optional(TrimmedNonEmptyString),
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelName: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  estimatedCostUsd: Schema.Number,
  records: NonNegativeInt,
  sessions: NonNegativeInt,
  generations: NonNegativeInt,
});
export type PiUsageRow = typeof PiUsageRow.Type;

export const UsageAccountingSummary = Schema.Struct({
  sources: Schema.Array(UsageAccountingSourceSummary),
  pi: Schema.Array(PiUsageRow),
});
export type UsageAccountingSummary = typeof UsageAccountingSummary.Type;

export const UsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  untilTime: Schema.optional(TrimmedNonEmptyString),
  /** Opt-in because provider billing may require bounded external API calls. */
  includeAccounting: Schema.optional(Schema.Boolean),
  awaitRefresh: Schema.optional(Schema.Boolean),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: ForwardCompatibleArray(UsageBucket),
  sources: ForwardCompatibleArray(UsageSource),
  pricing: UsagePricing,
  /** Optional for version-skew compatibility with servers before v6. */
  accounting: Schema.optional(UsageAccountingSummary),
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
