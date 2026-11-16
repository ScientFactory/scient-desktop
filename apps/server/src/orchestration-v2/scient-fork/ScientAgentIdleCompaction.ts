import {
  ModelSelection,
  RunId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PROVIDER_SESSION_IDLE_TIMEOUT_MS } from "../ProviderSessionManager.ts";

// Long enough for a one-hour cache's compaction to start before the idle session is released.
const RELEASE_LEAD_MS = 5 * 60_000;
// A five-minute cache's warm-until errs late by its last refresh's duration.
const WARM_MARGIN_MS = 60_000;
const sameSelection = Schema.toEquivalence(ModelSelection);

/**
 * When an idle Scient Agent thread should compact, or null. It compacts in the agent that still
 * holds the conversation and a warm cache: a one-hour cache before the server releases the idle
 * session, a five-minute cache once the agent's idle warming stops on a refresh. Never on a cold or
 * never-expiring cache, or after a model change whose requests would not read that cache.
 */
export function scientAgentIdleCompactionWindow(input: {
  readonly usage: OrchestrationV2ProviderTurnTokenUsage | undefined;
  readonly threadSelection: ModelSelection;
  readonly runSelection: ModelSelection;
  readonly nowMs: number;
}): { readonly startMs: number; readonly endMs: number } | null {
  const { usage, nowMs } = input;
  if (usage?.promptCacheTier === undefined) return null;
  if (!sameSelection(input.threadSelection, input.runSelection)) return null;
  const replyMs = Date.parse(usage.updatedAt);
  const expiresMs = Date.parse(usage.promptCacheExpiresAt ?? "");
  // A five-minute cache has an expiry only once warming stopped on it.
  if (!Number.isFinite(replyMs) || !Number.isFinite(expiresMs)) return null;
  const endMs =
    usage.promptCacheTier === "long"
      ? Math.min(expiresMs, replyMs + PROVIDER_SESSION_IDLE_TIMEOUT_MS)
      : expiresMs - WARM_MARGIN_MS;
  if (nowMs >= endMs) return null;
  return {
    startMs:
      usage.promptCacheTier === "long" ? Math.max(replyMs, endMs - RELEASE_LEAD_MS) : replyMs,
    endMs,
  };
}

/** A turn's five-minute cache got its warm-until: the agent's idle warming just stopped on it. */
export const scientWarmingStopped = (event: OrchestrationV2DomainEvent): boolean =>
  event.type === "provider-turn.updated" &&
  event.payload.tokenUsage?.promptCacheTier === "short" &&
  event.payload.tokenUsage.promptCacheExpiresAt !== undefined;

/** Matches no run, so idle compaction takes over the thread's latest completed run. */
export const LATEST_COMPLETED_RUN = RunId.make("scient:latest-completed-run");
