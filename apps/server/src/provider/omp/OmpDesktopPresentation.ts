import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderTurnTokenUsage,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import type { NativeRequestUsage } from "../../orchestration-v2/Adapters/NativeTurnUsage.ts";

// SCIENT-FORK: optional RPC observations are validated independently of turn routing.
const Counter = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Usage = Schema.Struct({
  input: Schema.optional(Counter),
  output: Schema.optional(Counter),
  cacheRead: Schema.optional(Counter),
  cacheWrite: Schema.optional(Counter),
  totalTokens: Schema.optional(Counter),
  reasoningTokens: Schema.optional(Counter),
});
const decodeUsage = Schema.decodeUnknownOption(Usage);
const Stats = Schema.Struct({
  cost: Schema.optional(Counter),
  tokens: Schema.optional(Schema.Struct({ total: Schema.optional(Counter) })),
  contextUsage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        tokens: Schema.optional(Counter),
        contextWindow: Schema.optional(Counter),
      }),
    ),
  ),
});
const decodeStats = Schema.decodeUnknownOption(Stats);
const TodoPhases = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    tasks: Schema.Array(
      Schema.Struct({
        content: Schema.String,
        status: Schema.Literals(["pending", "in_progress", "completed", "abandoned", "blocked"]),
        blocker: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const decodePhases = Schema.decodeUnknownOption(TodoPhases);

export const ompMessageUsage = (
  value: unknown,
  maxTokens?: number,
): Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt"> | undefined => {
  const usage = Option.getOrUndefined(decodeUsage(value));
  if (!usage || (usage.totalTokens === undefined && usage.input === undefined)) return;
  const inputTokens = Math.trunc(
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
  );
  return {
    usedTokens: Math.trunc(usage.totalTokens ?? inputTokens + (usage.output ?? 0)),
    maxTokens: maxTokens ?? null,
    inputTokens,
    cachedInputTokens: Math.trunc(usage.cacheRead ?? 0),
    outputTokens: Math.trunc(usage.output ?? 0),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningOutputTokens: Math.trunc(usage.reasoningTokens) }),
  };
};

// One assistant message is one model request, with the facts Scient Agent's /stats aggregates.
const RequestMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  duration: Schema.optional(Counter),
  ttft: Schema.optional(Counter),
  usage: Schema.Struct({
    input: Schema.optional(Counter),
    output: Schema.optional(Counter),
    cacheRead: Schema.optional(Counter),
    cacheWrite: Schema.optional(Counter),
    reasoningTokens: Schema.optional(Counter),
    cost: Schema.optional(Schema.Struct({ total: Schema.optional(Counter) })),
  }),
});
const decodeRequestMessage = Schema.decodeUnknownOption(RequestMessage);

/** The model request an assistant message reports, or undefined for other messages. */
export const ompRequestUsage = (message: unknown): NativeRequestUsage | undefined => {
  const decoded = Option.getOrUndefined(decodeRequestMessage(message));
  if (!decoded || (decoded.role !== undefined && decoded.role !== "assistant")) return;
  const { usage } = decoded;
  if (usage.input === undefined && usage.output === undefined) return;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    inputTokens: (usage.input ?? 0) + cacheRead + cacheWrite,
    outputTokens: usage.output ?? 0,
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(decoded.model === undefined ? {} : { model: decoded.model }),
    ...(usage.cost?.total === undefined ? {} : { costUsd: usage.cost.total }),
    ...(decoded.duration === undefined ? {} : { durationMs: decoded.duration }),
    ...(decoded.ttft === undefined ? {} : { firstTokenMs: decoded.ttft }),
    failed: decoded.stopReason === "error",
  };
};

export const ompStatsUsage = (
  value: unknown,
  previous?: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot | undefined => {
  const stats = Option.getOrUndefined(decodeStats(value));
  if (!stats || (stats.cost === undefined && stats.contextUsage?.tokens === undefined)) return;
  const window = stats.contextUsage?.contextWindow ?? previous?.maxTokens;
  return {
    ...previous,
    usedTokens: Math.trunc(stats.contextUsage?.tokens ?? previous?.usedTokens ?? 0),
    ...(window && window > 0 ? { maxTokens: Math.trunc(window) } : {}),
    ...(stats.cost === undefined ? {} : { cost: { amount: stats.cost, currency: "USD" } }),
    ...(stats.tokens?.total === undefined
      ? {}
      : { totalProcessedTokens: Math.trunc(stats.tokens.total) }),
  };
};

export const ompTodoSteps = (
  value: unknown,
): ReadonlyArray<OrchestrationV2PlanStep> | undefined => {
  const phases = Option.getOrUndefined(decodePhases(value));
  return phases?.flatMap((phase, phaseIndex) =>
    phase.tasks.flatMap((task, index) => {
      if (!task.content.trim()) return [];
      const suffix =
        task.status === "blocked"
          ? ` (blocked${task.blocker ? `: ${task.blocker}` : ""})`
          : task.status === "abandoned"
            ? " (abandoned)"
            : "";
      return [
        {
          id: `${phaseIndex}:${index}`,
          text: `${phase.name ? `${phase.name}: ` : ""}${task.content}${suffix}`,
          status:
            task.status === "in_progress"
              ? ("running" as const)
              : task.status === "completed" || task.status === "abandoned"
                ? ("completed" as const)
                : ("pending" as const),
        },
      ];
    }),
  );
};
