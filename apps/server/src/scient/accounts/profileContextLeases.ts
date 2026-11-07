import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import type { BrowserContext } from "playwright-core";

/** After this long a waiting tab or clear asks the copy to stop. */
const LEASE_WAIT_MS = 10_000;
/** A hold's closing of its context waits no longer; a context that doesn't close is dropped. */
const LEASE_CLOSE_DEADLINE_MS = 30_000;

/** What a hold needs of the browser's context pool. */
interface ContextPool {
  /** The pool's live contexts, by its own key. */
  readonly contexts: Map<string, Promise<BrowserContext>>;
  /** Opens or returns a persistent profile's context, as a tab would. */
  readonly contextFor: (profileId: string) => Promise<BrowserContext>;
}

interface Lease {
  readonly done: Promise<void>;
  wanted: boolean;
  stopping: boolean;
}

/**
 * One cookie copy at a time holds a persistent profile's context: tabs and clears wait for its
 * release, never alongside it. One waiting 10 s sets `stopping`, and the copy stops at its next
 * unit; a stalled cookie operation is aborted at its own deadline. Tabs waiting go before the next
 * hold. A context the hold opened closes on release unless a tab asked for it meanwhile.
 */
export class ProfileContextLeases {
  private readonly leases = new Map<string, Lease>();
  /** Tabs waiting for a hold to end; they go before the next hold, so none waits forever. */
  private readonly waitingTabs = new Map<string, Set<Promise<unknown>>>();
  /** The key a hold is opening right now, which its own `contextFor` call must not wait on. */
  private opening: string | undefined;

  private readonly pool: ContextPool;

  constructor(pool: ContextPool) {
    this.pool = pool;
  }

  /** A tab's context once the hold on its profile ends; undefined while nothing holds it. */
  tabWaits(key: string, open: () => Promise<BrowserContext>): Promise<BrowserContext> | undefined {
    if (this.opening === key || !this.leases.has(key)) return undefined;
    const waiting = this.released(key).then(open);
    const tabs = this.waitingTabs.get(key) ?? new Set();
    this.waitingTabs.set(key, tabs.add(waiting));
    void waiting.finally(() => {
      tabs.delete(waiting);
      if (tabs.size === 0 && this.waitingTabs.get(key) === tabs) this.waitingTabs.delete(key);
    });
    return waiting;
  }

  holds(key: string) {
    return this.leases.has(key);
  }

  /** A clear of the profile waits for its hold to end. */
  cleared(key: string) {
    return this.released(key);
  }

  /**
   * Holds a persistent profile's context until `release`. `discard` on release: the context
   * stopped answering. It is dropped, so the next tab or hold opens a fresh one from the same
   * profile folder, and closed as far as it will.
   */
  async lease(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) throw new Error("Incognito keeps no cookies.");
    const key = JSON.stringify([profileId, null]);
    for (;;) {
      const held = this.leases.get(key);
      const tabs = this.waitingTabs.get(key);
      if (held) await held.done;
      else if (tabs?.size) await Promise.allSettled(tabs);
      else break;
    }
    const done = Promise.withResolvers<void>();
    const lease: Lease = { done: done.promise, wanted: false, stopping: false };
    this.leases.set(key, lease);
    try {
      const { contexts } = this.pool;
      const opened = !contexts.has(key);
      // `contextFor` checks the hold before it awaits anything, so this one call goes through.
      this.opening = key;
      const opening = this.pool.contextFor(profileId);
      this.opening = undefined;
      const context = await opening;
      const pending = contexts.get(key);
      return {
        context,
        stopping: () => lease.stopping,
        release: async (options?: { readonly discard?: boolean }) => {
          if (options?.discard || (opened && !lease.wanted)) {
            if (contexts.get(key) === pending) contexts.delete(key);
            await new Promise<void>((resolve) => {
              // @effect-diagnostics-next-line globalTimers:off -- Playwright resources live outside Effect.
              const timer = setTimeout(resolve, LEASE_CLOSE_DEADLINE_MS);
              void context
                .close()
                .catch(constVoid)
                .finally(() => {
                  clearTimeout(timer);
                  resolve();
                });
            });
          }
          this.leases.delete(key);
          done.resolve();
        },
      };
    } catch (cause) {
      this.opening = undefined;
      this.leases.delete(key);
      done.resolve();
      throw cause;
    }
  }

  private released(key: string) {
    const lease = this.leases.get(key);
    if (!lease) return Promise.resolve();
    lease.wanted = true;
    // @effect-diagnostics-next-line globalTimers:off -- Playwright resources live outside Effect.
    const timer = setTimeout(() => (lease.stopping = true), LEASE_WAIT_MS);
    return lease.done.then(() => clearTimeout(timer));
  }
}
