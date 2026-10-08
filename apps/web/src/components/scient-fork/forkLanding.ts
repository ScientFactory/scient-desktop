/**
 * Scient-owned landing for a fork opened from the fork dialog. The fork's
 * messages stay invisible until its own history is loaded and positioned, and
 * then appear once, so the switch never paints the origin's rows, an empty
 * frame or the scroll settling. The mark is one-shot per destination thread
 * and expires on its own, so a fork that never settles is shown anyway.
 */

/** The longest a landing fork stays hidden, whatever its state. */
export const FORK_LANDING_TIMEOUT_MS = 1_800;

const pendingLandings = new Map<string, ReturnType<typeof setTimeout>>();
const landingListeners = new Set<() => void>();

function notifyLandingListeners(): void {
  for (const listener of landingListeners) listener();
}

/** Notifies when a fork landing starts or ends. */
export function subscribeForkLanding(listener: () => void): () => void {
  landingListeners.add(listener);
  return () => landingListeners.delete(listener);
}

/** Hides the destination's messages until it is ready or the timeout passes. */
export function markForkLanding(threadKey: string, timeoutMs = FORK_LANDING_TIMEOUT_MS): void {
  const previous = pendingLandings.get(threadKey);
  if (previous !== undefined) clearTimeout(previous);
  pendingLandings.set(
    threadKey,
    setTimeout(() => settleForkLanding(threadKey), timeoutMs),
  );
  notifyLandingListeners();
}

/** Ends a landing: the fork is ready, or it has waited long enough. */
export function settleForkLanding(threadKey: string): void {
  const timer = pendingLandings.get(threadKey);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingLandings.delete(threadKey);
  notifyLandingListeners();
}

export function isForkLandingPending(threadKey: string | null): boolean {
  return threadKey !== null && pendingLandings.has(threadKey);
}

/**
 * A landing fork is ready to show once its own timeline is on screen and in
 * place: the detail is loaded, the shown rows are the fork's rather than a
 * held thread's, and the list has finished positioning them. A deleted fork
 * shows at once; an empty one as soon as its detail is known.
 */
export function isForkLandingReady(input: {
  readonly threadKey: string;
  readonly threadExists: boolean;
  readonly threadDeleted: boolean;
  readonly detailLoaded: boolean;
  readonly displayedThreadKey: string | null;
  readonly timelineEmpty: boolean;
  readonly positionedThreadKey: string | null;
}): boolean {
  if (input.threadDeleted) return true;
  if (!input.threadExists || !input.detailLoaded) return false;
  if (input.displayedThreadKey !== input.threadKey) return false;
  return input.timelineEmpty || input.positionedThreadKey === input.threadKey;
}

/**
 * The thread whose rows a loaded list has put in place, else null. A position
 * restore that ran out of frames before the rows held still has not: the
 * landing waits for its expiry rather than show rows that may still move.
 */
export function settledListThreadKey(input: {
  readonly listThreadKey: string;
  readonly listLoaded: boolean;
  readonly restoring: boolean;
  readonly abandonedThreadKey: string | null;
}): string | null {
  return input.listLoaded && !input.restoring && input.abandonedThreadKey !== input.listThreadKey
    ? input.listThreadKey
    : null;
}
