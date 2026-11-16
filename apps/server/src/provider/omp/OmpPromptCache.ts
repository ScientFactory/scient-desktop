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
 * A one-hour entry carries its expiry; a five-minute one only its tier, since the agent keeps it warm
 * (`ompWarmingStopped` says when that stops). No frame clears what an earlier reply of the turn
 * recorded, since the turn's usage merges each reply's.
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

/** Scient Agent's warming stopped; the entry it left, when the next request would still read it. */
export interface OmpWarmingStopped {
  readonly stoppedAt: string;
  readonly expiresAt: string;
}

/**
 * What a `cache_warming_stopped` frame leaves for idle compaction: the five-minute entry warming left,
 * which nothing refreshes any more, or null when there is none (expired, conversation changed, a
 * one-hour entry, which compacts on its own schedule). `touchedAt` is the last refresh that hit.
 */
export const ompWarmingStopped = (
  event: unknown,
  stoppedAtMs: number,
): OmpWarmingStopped | null => {
  const frame = Option.getOrUndefined(decodePromptCacheFrame(event));
  if (frame?.promptCache.tier !== "short") return null;
  const { touchedAt, ttlMs } = frame.promptCache;
  return {
    stoppedAt: DateTime.formatIso(DateTime.makeUnsafe(stoppedAtMs)),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(touchedAt + ttlMs)),
  };
};
