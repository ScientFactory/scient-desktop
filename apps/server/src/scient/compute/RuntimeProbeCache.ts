import type { ComputeRuntimeError } from "@scientfactory/compute";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

export interface RuntimeProbeCache<A, E = ComputeRuntimeError> {
  /** One probe per key at a time; concurrent callers share it. */
  readonly get: (key: string, probe: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  /** A fresh success, without probing. */
  readonly peek: (key: string, now: number) => A | null;
  /** Records a success under another name for the same runtime. */
  readonly alias: (key: string, from: string) => void;
  readonly clear: () => void;
  /** Like `clear`, for one key. */
  readonly forget: (key: string) => void;
}

/**
 * Failures are kept briefly with their reason so reopening a file does not relaunch a runtime that
 * just failed; an explicit refresh clears everything.
 */
export function makeRuntimeProbeCache<A, E = ComputeRuntimeError>(
  options: {
    readonly successTtlMs?: number;
    readonly failureTtlMs?: number;
    readonly concurrency?: number;
  } = {},
): RuntimeProbeCache<A, E> {
  const successTtlMs = options.successTtlMs ?? 30_000;
  const failureTtlMs = options.failureTtlMs ?? 5_000;
  const permits = Semaphore.makeUnsafe(options.concurrency ?? 4);
  const entries = new Map<string, { readonly exit: Exit.Exit<A, E>; readonly at: number }>();
  const inFlight = new Map<string, Deferred.Deferred<A, E>>();
  /** A refresh starts a new generation: probes begun before it neither answer nor fill it. */
  let generation = 0;
  const keyGenerations = new Map<string, number>();

  const fresh = (key: string, now: number) => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    const ttl = Exit.isSuccess(entry.exit) ? successTtlMs : failureTtlMs;
    if (now - entry.at < ttl) return entry.exit;
    entries.delete(key);
    return null;
  };

  const get: RuntimeProbeCache<A, E>["get"] = Effect.fn("RuntimeProbeCache.get")(function* (
    key: string,
    probe: Effect.Effect<A, E>,
  ): Effect.fn.Return<A, E> {
    const now = yield* Clock.currentTimeMillis;
    const cached = fresh(key, now);
    if (cached !== null) return yield* cached;
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      const shared = yield* Effect.exit(Deferred.await(pending));
      // The probe's owner was interrupted; this caller still wants an answer.
      return yield* Exit.hasInterrupts(shared) ? get(key, probe) : shared;
    }
    const deferred = Deferred.makeUnsafe<A, E>();
    const started = generation;
    const startedForKey = keyGenerations.get(key) ?? 0;
    inFlight.set(key, deferred);
    return yield* permits
      .withPermits(1)(probe)
      .pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (inFlight.get(key) === deferred) inFlight.delete(key);
            // Freshness counts from the answer, not from when the probe was asked for.
            const at = yield* Clock.currentTimeMillis;
            const current =
              started === generation && startedForKey === (keyGenerations.get(key) ?? 0);
            if (!Exit.hasInterrupts(exit) && current) entries.set(key, { exit, at });
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
      );
  });

  return {
    get,
    peek: (key, now) => {
      const exit = fresh(key, now);
      return exit !== null && Exit.isSuccess(exit) ? exit.value : null;
    },
    alias: (key, from) => {
      const entry = entries.get(from);
      if (entry !== undefined && key !== from) entries.set(key, entry);
    },
    clear: () => {
      generation += 1;
      entries.clear();
      inFlight.clear();
    },
    forget: (key) => {
      keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1);
      entries.delete(key);
      inFlight.delete(key);
    },
  };
}
