import type { ProviderSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { ProviderAdapterV2SessionRuntime } from "../ProviderAdapter.ts";

type IdleEntry = {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly idleGeneration: number;
  readonly busyCount: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  readonly lastActivityAtMs: number;
};

/**
 * Pending canonical starts per provider session id, owned by one live manager.
 *
 * Opening or reusing a session arms its idle timer before the start has
 * prepared history, handoffs and the run row; the first native turn only marks
 * the session busy at the very end. A start therefore reserves the session id
 * before it opens or looks up the session, and idle retirement declines while
 * any reservation is outstanding. The count is separate from turn busy
 * accounting, so no turn terminal or failed start can consume it. Explicit
 * releases (Stop, detach, logout, shutdown) never consult it.
 */
export interface StartupSessionReservations {
  readonly reserve: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Called inside idle retirement's atomic reservation step; true declines retirement. */
  readonly declinesIdleRetirement: (
    providerSessionId: ProviderSessionId,
    entry: IdleEntry,
  ) => boolean;
}

/** Reservations registered by each live manager, keyed by the exact service object. */
const reservationsByManager = new WeakMap<object, StartupSessionReservations>();

export const registerStartupSessionReservations = (
  manager: object,
  reservations: StartupSessionReservations,
): void => {
  reservationsByManager.set(manager, reservations);
};

/** Reserves the session for this start until the caller's scope closes; other managers have none. */
export const reserveSessionForStartup = (
  manager: object,
  providerSessionId: ProviderSessionId,
): Effect.Effect<void, never, Scope.Scope> =>
  reservationsByManager.get(manager)?.reserve(providerSessionId) ?? Effect.void;

export const makeStartupSessionReservations = <Entry extends IdleEntry>(deps: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly sessionKey: (providerSessionId: ProviderSessionId) => string;
  readonly isReleasing: (runtime: ProviderAdapterV2SessionRuntime) => boolean;
  readonly cancelIdleFiber: (fiber: Fiber.Fiber<void, never> | null) => Effect.Effect<void>;
  /** Forks the manager's ordinary idle timer for exactly this runtime and generation. */
  readonly forkIdleTimer: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly generation: number;
    readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
  }) => Effect.Effect<Fiber.Fiber<void, never>>;
}): StartupSessionReservations => {
  const pending = new Map<string, number>();
  // The latest idle retirement declined during a reservation, per session id.
  const declined = new Map<
    string,
    { readonly runtime: ProviderAdapterV2SessionRuntime; readonly generation: number }
  >();

  /**
   * Re-arms only the exact runtime and idle generation whose retirement was
   * declined; any later activity or replacement armed its own timer. The check
   * claims the next generation in the same atomic step, so a replacement or
   * new activity cannot slip in between, and the new timer is installed only
   * while that claim is still current.
   */
  const rearmDeclined = (
    providerSessionId: ProviderSessionId,
    suppressed: { readonly runtime: ProviderAdapterV2SessionRuntime; readonly generation: number },
  ) =>
    Effect.gen(function* () {
      const key = deps.sessionKey(providerSessionId);
      const now = yield* Clock.currentTimeMillis;
      const generation = suppressed.generation + 1;
      const claimed = yield* Ref.modify(deps.sessions, (current) => {
        const entry = current.get(key);
        if (
          entry?.runtime !== suppressed.runtime ||
          entry.idleGeneration !== suppressed.generation ||
          entry.busyCount > 0 ||
          deps.isReleasing(entry.runtime)
        )
          return [undefined, current] as const;
        const updated = new Map(current);
        updated.set(key, {
          ...entry,
          idleGeneration: generation,
          idleFiber: null,
          lastActivityAtMs: now,
        });
        return [{ previous: entry.idleFiber }, updated] as const;
      });
      if (claimed === undefined) return;
      yield* deps.cancelIdleFiber(claimed.previous);
      const idleFiber = yield* deps.forkIdleTimer({
        providerSessionId,
        generation,
        expectedRuntime: suppressed.runtime,
      });
      const installed = yield* Ref.modify(deps.sessions, (current) => {
        const entry = current.get(key);
        if (
          entry?.runtime !== suppressed.runtime ||
          entry.idleGeneration !== generation ||
          entry.idleFiber !== null ||
          entry.busyCount > 0
        )
          return [false, current] as const;
        const updated = new Map(current);
        updated.set(key, { ...entry, idleFiber });
        return [true, updated] as const;
      });
      // Superseded meanwhile: the current owner of the entry owns its timer.
      if (!installed) yield* deps.cancelIdleFiber(idleFiber);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
          providerSessionId,
          cause,
        }),
      ),
    );

  const endReservation = (providerSessionId: ProviderSessionId) =>
    Effect.suspend(() => {
      const key = deps.sessionKey(providerSessionId);
      const remaining = (pending.get(key) ?? 1) - 1;
      if (remaining > 0) {
        pending.set(key, remaining);
        return Effect.void;
      }
      pending.delete(key);
      const suppressed = declined.get(key);
      declined.delete(key);
      return suppressed === undefined ? Effect.void : rearmDeclined(providerSessionId, suppressed);
    });

  return {
    reserve: (providerSessionId) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const key = deps.sessionKey(providerSessionId);
          pending.set(key, (pending.get(key) ?? 0) + 1);
        }),
        () => endReservation(providerSessionId),
      ),
    declinesIdleRetirement: (providerSessionId, entry) => {
      const key = deps.sessionKey(providerSessionId);
      if (!pending.has(key)) return false;
      declined.set(key, { runtime: entry.runtime, generation: entry.idleGeneration });
      return true;
    },
  };
};
