import { holdLock, type LockHold } from "./windowLocks";

/** `pending` until this window learns whether it or another app window hosts the tab. */
type PreviewHostRole = "pending" | "host" | "elsewhere";

export interface PreviewHostClaim {
  readonly role: () => PreviewHostRole;
  readonly subscribe: (listener: () => void) => () => void;
  /** Queues this window for the tab; the returned function withdraws it. */
  readonly start: () => () => void;
  /**
   * Whether this window shows the tab; a window that shows it outranks one that does not.
   * Settles once any resulting takeover or handoff has been requested.
   */
  readonly setDisplayed: (displayed: boolean) => Promise<void>;
  readonly showHere: () => void;
}

const takeOverOnShow = new Set<string>();

/** The next time this window shows the tab, it takes the page from the window hosting it. */
export function takeOverPreviewTabWhenShown(tabId: string): void {
  takeOverOnShow.add(tabId);
}

/** Whether this window should take the tab now that it shows it; asks once per request. */
export function consumePreviewTakeover(tabId: string): boolean {
  return takeOverOnShow.delete(tabId);
}

const hostLockName = (tabId: string) => `scient-preview-tab-host:${tabId}`;
const shownLockName = (tabId: string) => `scient-preview-tab-shown:${tabId}`;

/**
 * Decides which app window mounts one desktop preview tab's webview: the holder of an exclusive
 * Web Lock. Windows that show the tab also hold a shared lock, so `LockManager.query()` client
 * ids tell a holder that shows the tab from one that does not.
 */
export function createPreviewHostClaim(tabId: string, locks: LockManager): PreviewHostClaim {
  const hostLock = hostLockName(tabId);
  const shownLock = shownLockName(tabId);
  const listeners = new Set<() => void>();
  const state = {
    role: "pending" as PreviewHostRole,
    active: false,
    displayed: false,
    attempt: 0,
    pendingRequest: null as AbortController | null,
    releaseHost: null as (() => Promise<void>) | null,
    shown: null as LockHold | null,
  };

  const setRole = (next: PreviewHostRole) => {
    if (state.role === next) return;
    state.role = next;
    for (const listener of listeners) listener();
  };
  const isCurrent = (id: number) => state.active && id === state.attempt;

  // Call while holding the host lock: its holder entry identifies this window.
  const showingWindowWaits = async () => {
    const { held = [], pending = [] } = await locks.query();
    const self = held.find((lock) => lock.name === hostLock)?.clientId;
    const showing = new Set(
      held
        .filter((lock) => lock.name === shownLock && lock.clientId !== self)
        .map((lock) => lock.clientId),
    );
    return pending.some((lock) => lock.name === hostLock && showing.has(lock.clientId));
  };

  const hostIsHidden = async () => {
    const { held = [] } = await locks.query();
    const host = held.find((lock) => lock.name === hostLock);
    return (
      host !== undefined &&
      !held.some((lock) => lock.name === shownLock && lock.clientId === host.clientId)
    );
  };

  // Settles once this request hosts, yields, or ends.
  const request = (steal: boolean): Promise<void> => {
    const id = ++state.attempt;
    state.pendingRequest?.abort();
    // Web Locks rejects a steal that also carries an abort signal.
    const controller = steal ? null : new AbortController();
    state.pendingRequest = controller;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let decide!: () => void;
    const decided = new Promise<void>((resolve) => {
      decide = resolve;
    });
    const releaseThis = () => {
      release();
      return settled;
    };
    const settled: Promise<void> = locks
      .request(hostLock, controller ? { signal: controller.signal } : { steal: true }, async () => {
        if (state.pendingRequest === controller) state.pendingRequest = null;
        if (!isCurrent(id)) return;
        if (!steal && !state.displayed && (await showingWindowWaits())) return;
        if (!isCurrent(id)) return;
        state.releaseHost = releaseThis;
        setRole("host");
        decide();
        await held;
      })
      .catch(() => undefined)
      .then(() => {
        if (state.releaseHost === releaseThis) state.releaseHost = null;
        // A steal rejects this request while its callback still holds `held`; end the callback.
        release();
        decide();
        if (!isCurrent(id)) return;
        setRole("elsewhere");
        void request(false);
      });
    if (!controller) return decided;
    void locks.query().then(({ held: heldLocks = [] }) => {
      if (
        isCurrent(id) &&
        state.role === "pending" &&
        heldLocks.some((lock) => lock.name === hostLock)
      ) {
        setRole("elsewhere");
      }
    });
    return decided;
  };

  const show = async () => {
    const hold = holdLock(locks, shownLock, "shared");
    state.shown = hold;
    await hold.granted;
    const stillShown = () => state.active && state.shown === hold && state.role !== "host";
    if (stillShown() && (await hostIsHidden()) && stillShown()) await request(true);
  };

  const handOff = async () => {
    const id = state.attempt;
    if (!(await showingWindowWaits())) return;
    if (isCurrent(id) && state.role === "host" && !state.displayed) await state.releaseHost?.();
  };

  return {
    role: () => state.role,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      state.active = true;
      void request(false);
      if (state.displayed) void show().catch(() => undefined);
      return () => {
        state.active = false;
        state.attempt += 1;
        state.pendingRequest?.abort();
        state.pendingRequest = null;
        void state.releaseHost?.();
        state.releaseHost = null;
        void state.shown?.release();
        state.shown = null;
        setRole("pending");
      };
    },
    setDisplayed: async (displayed) => {
      if (state.displayed === displayed) return;
      state.displayed = displayed;
      if (!state.active) return;
      if (displayed) return show();
      void state.shown?.release();
      state.shown = null;
      if (state.role === "host") await handOff();
    },
    showHere: () => {
      if (state.active && state.role !== "host") void request(true);
    },
  };
}
