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
 * `usage` with when its one-hour prompt cache expires, which idle compaction
 * times itself against. A five-minute entry would compact after every short
 * pause, so only the one-hour tier carries an expiry.
 */
export const withOmpPromptCacheExpiry = (usage: TokenUsage, event: unknown): TokenUsage => {
  const frame = Option.getOrUndefined(decodePromptCacheFrame(event));
  if (frame?.promptCache.tier !== "long") return usage;
  const { touchedAt, ttlMs } = frame.promptCache;
  return {
    ...usage,
    promptCacheTtlMs: Math.trunc(ttlMs),
    promptCacheExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(touchedAt + ttlMs)),
  };
};
