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
 * Only a one-hour entry carries an expiry: the agent keeps a five-minute one warm while idle.
 * No frame clears what an earlier reply recorded, since the turn's usage merges each reply's.
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
