// SCIENT-OWNED: shares one SSH environment preparation per host across the
// desktop's connection retries. tunnel.ts wraps ensureEnvironment with it from
// one marked line.
//
// The renderer gives each saved-connection attempt about 15 seconds, then
// abandons it and retries, but preparing a host can take minutes the first
// time: installing the pinned Scient server package, or copying an earlier
// Scient home. The abandoned preparation keeps running here. A retry that finds
// it still running waits a bounded time, then fails at once as still preparing,
// so every retry is answered within the renderer's deadline. If the preparation
// then fails, the next attempt receives that failure instead of starting the
// same work again. The first caller still waits for the whole preparation, so a
// caller without a deadline, such as adding a new host, is unaffected.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

/** How long a retry waits for a running preparation; below the renderer's deadline. */
export const SSH_PREPARATION_JOIN_BUDGET = Duration.seconds(8);

interface RunningPreparation<A, E> {
  readonly done: Deferred.Deferred<Exit.Exit<A, E>>;
  /** Whether a retry was told "still preparing" and is waiting for the outcome. */
  waitersGaveUp: boolean;
}

export const makeSharedSshPreparation = <A, E>(stillPreparing: () => E) => {
  const running = new Map<string, RunningPreparation<A, E>>();
  // A failure only retries that gave up were waiting for; the next caller gets it once.
  const unreported = new Map<string, Exit.Exit<A, E>>();

  const run = Effect.fn("ssh/scientSshPreparation.run")(function* <R>(
    key: string,
    prepare: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    const missed = unreported.get(key);
    if (missed !== undefined) {
      unreported.delete(key);
      return yield* missed;
    }
    const current = running.get(key);
    if (current !== undefined) {
      const finished = yield* Deferred.await(current.done).pipe(
        Effect.timeoutOption(SSH_PREPARATION_JOIN_BUDGET),
      );
      if (Option.isNone(finished)) {
        current.waitersGaveUp = true;
        return yield* Effect.fail(stillPreparing());
      }
      // This caller received the failure, so it is not replayed. After a success
      // or an interruption, the caller prepares again: the work it waited for
      // left a reusable tunnel, or nothing.
      const exit = finished.value;
      if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) {
        unreported.delete(key);
        return yield* Effect.failCause(exit.cause);
      }
      return yield* run(key, prepare);
    }
    const preparation: RunningPreparation<A, E> = {
      done: yield* Deferred.make<Exit.Exit<A, E>>(),
      waitersGaveUp: false,
    };
    running.set(key, preparation);
    return yield* prepare.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          running.delete(key);
          // Recorded before waiters resume, so one that receives it can clear it.
          if (
            Exit.isFailure(exit) &&
            !Cause.hasInterrupts(exit.cause) &&
            preparation.waitersGaveUp
          ) {
            unreported.set(key, exit);
          }
          yield* Deferred.succeed(preparation.done, exit);
        }),
      ),
    );
  });

  return { run };
};
