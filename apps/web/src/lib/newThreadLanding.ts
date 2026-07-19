// Tracks only the first route landing for a freshly created local draft. This
// is intentionally ephemeral: persisted or reopened drafts must mount normally.
const pendingNewThreadLandings = new Set<string>();

export function markNewThreadLanding(threadId: string): void {
  pendingNewThreadLandings.add(threadId);
}

export function isNewThreadLandingPending(threadId: string): boolean {
  return pendingNewThreadLandings.has(threadId);
}

export function clearNewThreadLanding(threadId: string): void {
  pendingNewThreadLandings.delete(threadId);
}
