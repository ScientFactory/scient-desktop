import {
  ModelSelection,
  RunId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PROVIDER_SESSION_IDLE_TIMEOUT_MS } from "../ProviderSessionManager.ts";

// Long enough for a one-hour cache's compaction to start before the idle session is released.
const RELEASE_LEAD_MS = 5 * 60_000;
// Time for a dispatched /compact to reach the provider while the entry is still warm.
const WARM_MARGIN_MS = 60_000;
// Warming that stops sooner (its savings rule, a run that settles right after a long reply) leaves
// a reader still reading; the cache is let go, as one never warmed is.
const MIN_IDLE_MS = 20 * 60_000;
const sameSelection = Schema.toEquivalence(ModelSelection);

/**
 * When an idle Scient Agent thread should compact, or null. It compacts in the agent that still
 * holds the conversation and a warm cache: a one-hour cache before the server releases the idle
 * session, a five-minute cache when the agent's warming stopped on it after a long idle stretch.
 * Never on a cold or never-expiring cache, or after a model change whose requests would not read it.
 */
export function scientAgentIdleCompactionWindow(input: {
  readonly usage: OrchestrationV2ProviderTurnTokenUsage | undefined;
  readonly warmingStopped: OrchestrationV2ProviderThread["promptCacheWarmingStopped"];
  readonly threadSelection: ModelSelection;
  readonly runSelection: ModelSelection;
  readonly nowMs: number;
}): { readonly startMs: number; readonly endMs: number } | null {
  const { usage, nowMs } = input;
  if (usage?.promptCacheTier === undefined) return null;
  if (!sameSelection(input.threadSelection, input.runSelection)) return null;
  const replyMs = Date.parse(usage.updatedAt);
  if (!Number.isFinite(replyMs)) return null;
  if (usage.promptCacheTier === "long") {
    const expiresMs = Date.parse(usage.promptCacheExpiresAt ?? "");
    if (!Number.isFinite(expiresMs)) return null;
    const endMs = Math.min(expiresMs, replyMs + PROVIDER_SESSION_IDLE_TIMEOUT_MS);
    return nowMs >= endMs ? null : { startMs: Math.max(replyMs, endMs - RELEASE_LEAD_MS), endMs };
  }
  const stoppedMs = Date.parse(input.warmingStopped?.stoppedAt ?? "");
  const endMs = Date.parse(input.warmingStopped?.expiresAt ?? "") - WARM_MARGIN_MS;
  // A stop recorded before this reply, or soon after it, says nothing about this idle stretch.
  if (!Number.isFinite(stoppedMs) || !Number.isFinite(endMs) || stoppedMs < replyMs + MIN_IDLE_MS)
    return null;
  return nowMs >= endMs ? null : { startMs: stoppedMs, endMs };
}

/** Scient Agent's warming stopped on a thread's still-warm five-minute cache. */
export const scientWarmingStopped = (event: OrchestrationV2DomainEvent): boolean =>
  event.type === "provider-thread.updated" && event.payload.promptCacheWarmingStopped != null;

/** Matches no run, so idle compaction takes over the thread's latest completed run. */
export const LATEST_COMPLETED_RUN = RunId.make("scient:latest-completed-run");
