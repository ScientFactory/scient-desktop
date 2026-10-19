// SCIENT-OWNED: runs a long SSH host preparation as a job the environment
// manager owns, so a saved connection that retries is answered in time.
// tunnel.ts uses it from one marked step.
//
// The renderer gives each saved-connection attempt about 15 seconds, then
// abandons it and retries, but preparing a host can take minutes the first
// time: installing the pinned Scient server package, or copying an earlier
// Scient home. The preparation runs in the manager's scope, not in any
// caller's fiber. A saved connection asks for a bounded wait: it waits up to
// SSH_PREPARATION_JOIN_BUDGET and otherwise fails at once as still preparing,
// so no attempt is abandoned mid-wait. Any other caller, such as adding a new
// host, waits for the whole preparation as before. The outcome goes to the
// first caller that receives it; if nobody was waiting, the next caller gets
// it, so a failure is reported instead of the work starting over.
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

/** How long a saved connection waits; leaves room under the renderer's deadline. */
const SSH_PREPARATION_JOIN_BUDGET = Duration.seconds(8);

interface PreparationJob<E> {
  readonly done: Deferred.Deferred<void, E>;
  outcome: Exit.Exit<void, E> | undefined;
}

export const makeSharedSshPreparation = <E>(scope: Scope.Scope, stillPreparing: () => E) => {
  const jobs = new Map<string, PreparationJob<E>>();

  // The lookup and the claim happen in one synchronous step, so concurrent
  // callers share one job per host. The outcome is published by observing the
  // forked fiber, which also covers a job interrupted before it starts.
  const claim = <R>(key: string, prepare: Effect.Effect<void, E, R>) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const existing = jobs.get(key);
        if (existing !== undefined) return Effect.succeed(existing);
        const job: PreparationJob<E> = { done: Deferred.makeUnsafe<void, E>(), outcome: undefined };
        jobs.set(key, job);
        return Effect.map(Effect.forkIn(prepare, scope), (fiber) => {
          fiber.addObserver((exit) => {
            job.outcome = exit;
            Deferred.doneUnsafe(job.done, exit);
          });
          return job;
        });
      }),
    );

  // A caller that receives an outcome retires its own job, never a newer one.
  const receive = (key: string, job: PreparationJob<E>, outcome: Exit.Exit<void, E>) => {
    if (jobs.get(key) === job) jobs.delete(key);
    return outcome;
  };

  const await_ = Effect.fn("ssh/scientSshPreparation.await")(function* <R>(
    key: string,
    prepare: Effect.Effect<void, E, R>,
    boundedWait: boolean,
  ): Effect.fn.Return<void, E, R> {
    const job = yield* claim(key, prepare);
    if (job.outcome !== undefined) return yield* receive(key, job, job.outcome);
    const settled = Effect.exit(Deferred.await(job.done));
    if (!boundedWait) return yield* receive(key, job, yield* settled);
    const finished = yield* settled.pipe(Effect.timeoutOption(SSH_PREPARATION_JOIN_BUDGET));
    if (Option.isNone(finished)) return yield* Effect.fail(stillPreparing());
    return yield* receive(key, job, finished.value);
  });

  return { await: await_ };
};
