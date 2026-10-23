import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { OmpRpcProcess, OmpProcessExit } from "../../provider/omp/OmpRpcProcess.ts";

/** Reuse only confirmed exits; an uncertain process keeps its conversation lock. */
export const makeOmpProcessOwnership = Effect.fn("OmpProcessOwnership.makeOmpProcessOwnership")(
  function* <E>(input: {
    readonly shutdown: () => OmpRpcProcess["shutdown"];
    readonly releaseLock: () => Effect.Effect<void>;
    readonly unconfirmed: () => Effect.Effect<void, E>;
  }) {
    let confirmedExit: OmpProcessExit | undefined;
    const permit = yield* Semaphore.make(1);
    const shutdown = permit.withPermit(
      Effect.suspend(() =>
        confirmedExit !== undefined
          ? Effect.succeed(confirmedExit)
          : input.shutdown().pipe(
              Effect.tap((exit) =>
                Effect.sync(() => {
                  if (exit.code !== null || exit.exited === true) confirmedExit = exit;
                }),
              ),
            ),
      ).pipe(Effect.uninterruptible),
    );
    const stop = Effect.gen(function* () {
      const exit = yield* shutdown;
      if (exit.code === null && exit.exited !== true) return yield* input.unconfirmed();
      yield* input.releaseLock();
    });
    return { shutdown, stop };
  },
);
