import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";

import { PROVIDER_SESSION_IDLE_TIMEOUT_MS } from "../ProviderSessionManager.ts";

// Scient Agent keeps a five-minute cache warm for 30 minutes after the request it serves.
const AGENT_IDLE_WARMING_MS = 30 * 60_000;
// Long enough for the compaction to start before the session is released and the warming stops.
const LEAD_MS = 5 * 60_000;

/**
 * When an idle Scient Agent thread should compact, or null. It compacts in the agent that
 * still holds the conversation, before the server releases the idle session: a respawned
 * agent can rebuild a different prefix and miss even a one-hour cache. A turn without a
 * confirmed, expiring cache (a cache that never expires, an older agent) never compacts.
 */
export function scientAgentIdleCompactionWindow(
  usage: OrchestrationV2ProviderTurnTokenUsage | undefined,
  nowMs: number,
): { readonly startMs: number; readonly endMs: number } | null {
  if (usage?.promptCacheTier === undefined) return null;
  const replyMs = Date.parse(usage.updatedAt);
  if (!Number.isFinite(replyMs)) return null;
  let endMs = replyMs + Math.min(PROVIDER_SESSION_IDLE_TIMEOUT_MS, AGENT_IDLE_WARMING_MS);
  if (usage.promptCacheTier === "long") {
    const expiresMs = Date.parse(usage.promptCacheExpiresAt ?? "");
    if (!Number.isFinite(expiresMs)) return null;
    endMs = Math.min(endMs, expiresMs);
  }
  if (nowMs >= endMs) return null;
  return { startMs: Math.max(replyMs, endMs - LEAD_MS), endMs };
}
