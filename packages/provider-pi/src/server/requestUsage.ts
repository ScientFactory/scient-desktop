import type { NativeRequestUsage } from "@t3tools/provider-core/server/turnUsage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Counter = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  model: Schema.optional(Schema.String),
  responseModel: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  duration: Schema.optional(Counter),
  ttft: Schema.optional(Counter),
  usage: Schema.Struct({
    input: Schema.optional(Counter),
    output: Schema.optional(Counter),
    cacheRead: Schema.optional(Counter),
    cacheWrite: Schema.optional(Counter),
    reasoning: Schema.optional(Counter),
    cost: Schema.optional(Schema.Struct({ total: Schema.optional(Counter) })),
  }),
});
const decodeAssistantMessage = Schema.decodeUnknownOption(AssistantMessage);

/** The model request a finished assistant message reports. Pi's input and cache counts are disjoint. */
export function piRequestUsage(message: unknown): NativeRequestUsage | undefined {
  const decoded = Option.getOrUndefined(decodeAssistantMessage(message));
  if (!decoded) return undefined;
  const { usage } = decoded;
  if (usage.input === undefined && usage.output === undefined) return undefined;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const model = decoded.responseModel ?? decoded.model;
  return {
    inputTokens: (usage.input ?? 0) + cacheRead + cacheWrite,
    outputTokens: usage.output ?? 0,
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    ...(model === undefined ? {} : { model }),
    // Pi reports zero for models it has no price for, so only a positive total is an estimate.
    ...(usage.cost?.total === undefined || usage.cost.total <= 0
      ? {}
      : { costUsd: usage.cost.total }),
    ...(decoded.duration === undefined ? {} : { durationMs: decoded.duration }),
    ...(decoded.ttft === undefined ? {} : { firstTokenMs: decoded.ttft }),
    failed: decoded.stopReason === "error",
  };
}
