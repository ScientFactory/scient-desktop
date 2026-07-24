// Tracks only the first route landing for a freshly created local draft. This
// is intentionally ephemeral: persisted or reopened drafts must mount normally.
const pendingNewThreadLandings = new Set<string>();
const stagedNewThreadDrafts = new Set<string>();

export function markNewThreadLanding(threadId: string): void {
  pendingNewThreadLandings.add(threadId);
}

export function isNewThreadLandingPending(threadId: string): boolean {
  return pendingNewThreadLandings.has(threadId);
}

export function clearNewThreadLanding(threadId: string): void {
  pendingNewThreadLandings.delete(threadId);
}

/**
 * Tracks fresh drafts that are visible in the route but have not yet won navigation ownership.
 * A newer New Thread action must not reuse one of these transient drafts while the older
 * navigation promise is still pending; the older owner may subsequently roll it back.
 */
export function markNewThreadDraftStaged(threadId: string): void {
  stagedNewThreadDrafts.add(threadId);
}

export function isNewThreadDraftStaged(threadId: string): boolean {
  return stagedNewThreadDrafts.has(threadId);
}

export function clearNewThreadDraftStaged(threadId: string): void {
  stagedNewThreadDrafts.delete(threadId);
}
