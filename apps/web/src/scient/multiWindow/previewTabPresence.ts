const PRESENCE_LOCK_PREFIX = "scient-preview-tab-lease:";

/** Web Locks shared by every app window of the desktop shell; other clients have one window. */
export function previewWindowLocks(): LockManager | undefined {
  if (typeof window === "undefined" || !window.desktopBridge?.preview) return undefined;
  return globalThis.navigator?.locks;
}

export interface LockHold {
  readonly granted: Promise<void>;
  /** Settles once the lock manager has released the lock. */
  readonly release: () => Promise<void>;
}

export function holdLock(locks: LockManager, name: string, mode: LockMode): LockHold {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grant!: () => void;
  const granted = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const settled = locks
    .request(name, { mode }, () => {
      grant();
      return held;
    })
    .then(
      () => undefined,
      () => undefined,
    );
  // A failed request must not leave the tab waiting forever; it degrades to a single window.
  void settled.then(grant);
  return {
    granted,
    release: () => {
      release();
      return settled;
    },
  };
}

const presenceByTabId = new Map<string, LockHold>();

/**
 * Marks the desktop tab as in use by this window. Resolves once no other window is closing it,
 * so a creation that follows cannot be undone by that close.
 */
export function retainPreviewTabPresence(tabId: string): Promise<void> {
  const locks = previewWindowLocks();
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
  const locks = previewWindowLocks();
  if (!locks) return close();
  await hold?.release();
  await locks.request(`${PRESENCE_LOCK_PREFIX}${tabId}`, { ifAvailable: true }, async (lock) => {
    // Held exclusively through the close, so another window's creation waits for it.
    if (lock && !presenceByTabId.has(tabId)) await close();
  });
}
