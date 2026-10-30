import * as Effect from "effect/Effect";

export type WindowLocks = Pick<LockManager, "request">;

/** Web Locks span every window of an origin, so they order work across app windows. */
export function browserWindowLocks(): WindowLocks | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}

/** Holds a cross-window lock for the effect; when the lock cannot be requested it runs unlocked. */
function withWindowLock(locks: WindowLocks | null, name: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    locks === null
      ? effect
      : Effect.acquireUseRelease(
          Effect.callback<() => void>((resume) => {
            locks
              .request(name, () => new Promise<void>((release) => resume(Effect.succeed(release))))
              .catch(() => resume(Effect.succeed(() => undefined)));
          }),
          () => effect,
          (release) => Effect.sync(release),
        );
}

/** `withWindowLock` for promises. */
export function runWithWindowLock<A>(
  locks: WindowLocks | null,
  name: string,
  work: () => Promise<A>,
): Promise<A> {
  if (locks === null) return work();
  let started = false;
  return locks
    .request(name, () => {
      started = true;
      return work();
    })
    .catch((error: unknown) => {
      if (started) throw error;
      return work();
    });
}

/** Desktop windows share the saved connection catalog; its edits take turns across them. */
export const catalogWriteLock = () =>
  withWindowLock(browserWindowLocks(), "scient-connection-catalog-write");

/** Web Locks shared by the desktop app's windows; null in other clients, which have one window. */
export function desktopWindowLocks(): LockManager | null {
  if (typeof window === "undefined" || window.desktopBridge === undefined) return null;
  return navigator.locks;
}

export interface LockHold {
  readonly granted: Promise<void>;
  /** Settles once the lock manager has released the lock. */
  readonly release: () => Promise<void>;
}

export function holdLock(locks: WindowLocks, name: string, mode: LockMode): LockHold {
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
  // A failed request must not leave its holder waiting forever; it degrades to a single window.
  void settled.then(grant);
  return {
    granted,
    release: () => {
      release();
      return settled;
    },
  };
}
