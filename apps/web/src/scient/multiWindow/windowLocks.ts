import * as Effect from "effect/Effect";

export type WindowLocks = Pick<LockManager, "request">;

/** Web Locks span every window of an origin, so they order work across app windows. */
export function browserWindowLocks(): WindowLocks | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}

/** Holds a cross-window lock for the effect; when the lock cannot be requested it runs unlocked. */
export function withWindowLock(locks: WindowLocks | null, name: string) {
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
