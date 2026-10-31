import { desktopWindowLocks, holdLock, type LockHold } from "./windowLocks";

const PRESENCE_LOCK_PREFIX = "scient-preview-tab-lease:";

const presenceByTabId = new Map<string, LockHold>();

/**
 * Marks the desktop tab as in use by this window. Resolves once no other window is closing it,
 * so a creation that follows cannot be undone by that close.
 */
export function retainPreviewTabPresence(tabId: string): Promise<void> {
  const locks = desktopWindowLocks();
  if (!locks) return Promise.resolve();
  const current = presenceByTabId.get(tabId);
  if (current) return current.granted;
  const hold = holdLock(locks, `${PRESENCE_LOCK_PREFIX}${tabId}`, "shared");
  presenceByTabId.set(tabId, hold);
  return hold.granted;
}

/** Drops this window's use of the tab and runs `close` only when no other window still uses it. */
export async function closeUnlessUsedElsewhere(
  tabId: string,
  close: () => Promise<void>,
): Promise<void> {
  const hold = presenceByTabId.get(tabId);
  presenceByTabId.delete(tabId);
  const locks = desktopWindowLocks();
  if (!locks) return close();
  await hold?.release();
  await locks.request(`${PRESENCE_LOCK_PREFIX}${tabId}`, { ifAvailable: true }, async (lock) => {
    // Held exclusively through the close, so another window's creation waits for it.
    if (lock) await close();
  });
}
