import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Scient Agent puts the prompt-cache entry a reply confirmed on its message_end; older agents omit it.
const PromptCacheFrame = Schema.Struct({
  promptCache: Schema.Struct({
    tier: Schema.Literals(["short", "long"]),
    touchedAt: Schema.Finite.check(Schema.isGreaterThan(0)),
    ttlMs: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
});
const decodePromptCacheFrame = Schema.decodeUnknownOption(PromptCacheFrame);

type TokenUsage = Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">;

/**
 * A one-hour entry carries its expiry. A five-minute one gets an expiry only when the agent's idle
 * warming stops on a refresh (`ompWarmingStopExpiry`). No frame clears what an earlier reply of the
 * turn recorded, since the turn's usage merges each reply's.
 */
export const withOmpPromptCacheExpiry = (usage: TokenUsage, event: unknown): TokenUsage => {
  const frame = Option.getOrUndefined(decodePromptCacheFrame(event));
  if (frame === undefined)
    return {
      ...usage,
      promptCacheTier: undefined,
      promptCacheTtlMs: undefined,
      promptCacheExpiresAt: undefined,
    };
  const { tier, touchedAt, ttlMs } = frame.promptCache;
  if (tier === "short")
    return {
      ...usage,
      promptCacheTier: tier,
      promptCacheTtlMs: undefined,
      promptCacheExpiresAt: undefined,
    };
  return {
    ...usage,
    promptCacheTier: tier,
    promptCacheTtlMs: Math.trunc(ttlMs),
    promptCacheExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(touchedAt + ttlMs)),
  };
};

/** The lifetime of a five-minute entry a reply confirmed; undefined for any other reply. */
export const ompShortCacheTtlMs = (event: unknown): number | undefined => {
  const frame = Option.getOrUndefined(decodePromptCacheFrame(event));
  return frame?.promptCache.tier === "short" ? Math.trunc(frame.promptCache.ttlMs) : undefined;
};

// An idle refresh that hit, after which the agent stopped warming (its 30-minute idle limit).
const WarmingStopFrame = Schema.Struct({
  type: Schema.Literal("cache_warming_end"),
  phase: Schema.Literal("idle"),
  outcome: Schema.Literal("hit"),
  warmingStopReason: Schema.String,
});
const decodeWarmingStopFrame = Schema.decodeUnknownOption(WarmingStopFrame);

/**
 * Until when a five-minute entry stays warm after the agent's last idle refresh, which restarted its
 * lifetime; nothing refreshes it again. The refresh was sent before `receivedAtMs`, so this errs late.
 */
export const ompWarmingStopExpiry = (
  event: unknown,
  ttlMs: number | undefined,
  receivedAtMs: number,
): string | undefined =>
  ttlMs === undefined || Option.isNone(decodeWarmingStopFrame(event))
    ? undefined
    : DateTime.formatIso(DateTime.makeUnsafe(receivedAtMs + ttlMs));
