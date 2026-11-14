import type {
  ProviderConnectionAccount,
  ScientAgentSettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
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
const UsageLimit = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
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
    usedFraction: Schema.optional(Schema.Finite),
    remainingFraction: Schema.optional(Schema.Finite),
    unit: Schema.String,
  }),
  status: Schema.optional(Schema.String),
});
const UsageReport = Schema.Struct({
  provider: Schema.String,
  limits: Schema.Array(UsageLimit),
  metadata: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
      accountId: Schema.optional(Schema.String),
    }),
  ),
});
const UsageOutput = Schema.Struct({ reports: Schema.Array(UsageReport) });
const decodeUsageOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageOutput));

type UsageLimit = typeof UsageLimit.Type;

/** The agent's own precedence: explicit fraction, used/limit, percent used, inverted remaining. */
function usedFraction(amount: UsageLimit["amount"]): number | undefined {
  if (amount.usedFraction !== undefined) return amount.usedFraction;
  if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0)
    return amount.used / amount.limit;
  if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
  if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
  return undefined;
}

const HOUR_MS = 60 * 60 * 1000;
function windowKind(durationMs: number | undefined): ServerProviderUsageWindow["kind"] {
  if (durationMs === undefined) return "other";
  if (durationMs <= 24 * HOUR_MS) return "session";
  if (durationMs <= 8 * 24 * HOUR_MS) return "weekly";
  if (durationMs >= 28 * 24 * HOUR_MS) return "monthly";
  return "other";
}

/**
 * The agent's usage report as usage bars, one per window of each signed-in model account. Each
 * window names its account and applies to that account's models only.
 */
export function scientAgentUsageLimits(input: {
  readonly output: typeof UsageOutput.Type;
  readonly accounts: ReadonlyArray<ProviderConnectionAccount> | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const reportsPerProvider = new Map<string, number>();
  for (const report of input.output.reports)
    reportsPerProvider.set(report.provider, (reportsPerProvider.get(report.provider) ?? 0) + 1);
  const seen = new Map<string, number>();
  const windows: ServerProviderUsageWindow[] = [];
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
    for (const limit of report.limits) {
      const fraction = usedFraction(limit.amount);
      if (fraction === undefined) continue;
      const durationMs = limit.window?.durationMs;
      const resetsAt = limit.window?.resetsAt;
      windows.push({
        id: index === 0 ? limit.id : `${limit.id}#${index + 1}`,
        kind: windowKind(durationMs),
        label: `${account} · ${limit.window?.label ?? limit.label}`,
        providerIds: [report.provider],
        usedPercent: limit.status === "exhausted" ? 100 : clampPercent(fraction * 100),
        ...(resetsAt !== undefined && Number.isFinite(resetsAt)
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt)) }
          : {}),
        ...(durationMs !== undefined && durationMs > 0
          ? { windowDurationMins: Math.round(durationMs / 60_000) }
          : {}),
      });
    }
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}

/**
 * Reads usage limits for the agent's signed-in accounts; undefined without one. A failed read
 * keeps the last bars. The agent caches each provider's answer, so this is cheap to repeat.
 */
export const readScientAgentUsageLimits = Effect.fn("readScientAgentUsageLimits")(function* (
  run: (args: ReadonlyArray<string>) => Effect.Effect<string, { readonly message: string }>,
  accounts: ReadonlyArray<ProviderConnectionAccount> | undefined,
) {
  if (!accounts?.some((account) => account.connected)) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* run(["usage", "--json"]).pipe(
    Effect.flatMap(decodeUsageOutput),
    Effect.map((output) => scientAgentUsageLimits({ output, accounts, checkedAt })),
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
const scientAgentUsageFormat: TranscriptUsageFormat<unknown> = {
  ...(piUsageFormat as TranscriptUsageFormat<unknown>),
  parseLine: (line, state) =>
    (piUsageFormat as TranscriptUsageFormat<unknown>).parseLine(line, state).map(asScientAgent),
  parseProjected: (projected, state) =>
    (piUsageFormat as TranscriptUsageFormat<unknown>)
      .parseProjected(projected, state)
      .map(asScientAgent),
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
