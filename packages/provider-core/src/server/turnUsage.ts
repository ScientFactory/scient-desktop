import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@t3tools/contracts";

/** One model request's counts, as a native agent reports them; added up per provider turn. */
export interface NativeRequestUsage {
  /** All input, including tokens read from or written to the prompt cache. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  /** Part of `outputTokens`, when the provider reports it. */
  readonly reasoningTokens?: number;
  readonly model?: string;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly firstTokenMs?: number;
  readonly failed?: boolean;
}

export interface NativeTurnUsage {
  readonly requests: number;
  readonly failedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  /** Undefined once any request did not report it, since unknown is not zero. */
  readonly reasoningTokens: number | undefined;
  readonly costUsd: number | undefined;
  readonly modelDurationMs: number | undefined;
  readonly firstTokenMs: number | undefined;
  /** Each reported model's input and output tokens, in the order first seen. */
  readonly models: ReadonlyMap<string, number>;
}

const count = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) || value < 0 ? 0 : Math.trunc(value);

function addKnown(total: number | undefined, value: number | undefined, first: boolean) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return first ? value : total === undefined ? undefined : total + value;
}

export function addRequestUsage(
  total: NativeTurnUsage | undefined,
  request: NativeRequestUsage,
): NativeTurnUsage {
  const first = total === undefined;
  return {
    requests: (total?.requests ?? 0) + 1,
    failedRequests: (total?.failedRequests ?? 0) + (request.failed === true ? 1 : 0),
    inputTokens: (total?.inputTokens ?? 0) + count(request.inputTokens),
    outputTokens: (total?.outputTokens ?? 0) + count(request.outputTokens),
    cachedInputTokens: (total?.cachedInputTokens ?? 0) + count(request.cachedInputTokens),
    cacheCreationTokens: (total?.cacheCreationTokens ?? 0) + count(request.cacheCreationTokens),
    reasoningTokens: addKnown(total?.reasoningTokens, request.reasoningTokens, first),
    costUsd: addKnown(total?.costUsd, request.costUsd, first),
    modelDurationMs: addKnown(total?.modelDurationMs, request.durationMs, first),
    firstTokenMs: first ? request.firstTokenMs : total.firstTokenMs,
    models: withModelTokens(total?.models, request),
  };
}

function withModelTokens(
  models: ReadonlyMap<string, number> | undefined,
  request: NativeRequestUsage,
): ReadonlyMap<string, number> {
  const model = request.model?.trim();
  if (model === undefined || model === "") return models ?? new Map();
  const next = new Map(models);
  next.set(
    model,
    (next.get(model) ?? 0) + count(request.inputTokens) + count(request.outputTokens),
  );
  return next;
}

/** The provider turn's usage: complete only when the turn completed. */
export function nativeTurnTokenUsage(
  usage: NativeTurnUsage,
  status: OrchestrationV2ProviderTurn["status"],
  hasSubagents: boolean,
): TurnTokenUsage {
  const optional = (value: number | undefined) =>
    value === undefined ? undefined : Math.trunc(value);
  return {
    usageScope: "main_agent",
    usageStatus: status === "completed" ? "complete" : "partial",
    hasSubagents,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: Math.min(optional(usage.reasoningTokens)!, usage.outputTokens) }),
    // The model with the most tokens comes first; ties keep the order first seen.
    ...(usage.models.size === 0
      ? {}
      : {
          models: [...usage.models]
            .toSorted((left, right) => right[1] - left[1])
            .map(([model]) => model),
        }),
    requests: usage.requests,
    failedRequests: usage.failedRequests,
    ...(usage.costUsd === undefined ? {} : { estimatedCostUsd: usage.costUsd }),
    ...(usage.modelDurationMs === undefined
      ? {}
      : { modelDurationMs: optional(usage.modelDurationMs) }),
    ...(usage.firstTokenMs === undefined ? {} : { firstTokenMs: optional(usage.firstTokenMs) }),
  };
}
