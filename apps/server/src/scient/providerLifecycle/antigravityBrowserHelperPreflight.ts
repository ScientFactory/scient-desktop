/**
 * Runs the Antigravity browser-helper preflight once per helper executable for
 * each server process.
 *
 * The preflight proves that the `BROWSER` helper prints its marker and exits 0,
 * which keeps the agent from opening a browser of its own. Its result depends on
 * the executable, which cannot change while the server runs (an app update
 * restarts it), so a success is kept. A failure is not: the next sign-in checks
 * again.
 *
 * Two costs made the old per-launch check slow under load, and its 5-second
 * bound did not hold:
 * - Creating the process is synchronous in Node on Windows. Starting Scient.exe
 *   as the helper can block the event loop for seconds, and no timer can fire
 *   meanwhile. Only running the check once removes that cost.
 * - A timeout used to wait for the helper's teardown, which on Windows runs
 *   `taskkill` and then waits for the process to exit without a bound. The
 *   teardown now continues in the background.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

// Keyed by the spawner so a server process, which has one, verifies each
// helper once, while a test that substitutes a spawner sees its own runs.
const verifiedHelpers = new WeakMap<object, Set<string>>();

export const verifyAntigravityBrowserHelperOnce =
  <E2>(options: {
    readonly spawner: object;
    readonly helperExecutable: string;
    readonly timeout: Duration.Input;
    readonly onTimeout: () => E2;
  }) =>
  <E, R>(verify: Effect.Effect<void, E, R>): Effect.Effect<void, E | E2, Exclude<R, Scope.Scope>> =>
    Effect.suspend(() => {
      if (verifiedHelpers.get(options.spawner)?.has(options.helperExecutable)) {
        return Effect.void;
      }
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Started immediately so the process exists before the deadline is armed, as before:
          // the bound applies to the helper's run, not to process creation.
          const fiber = yield* Effect.forkDetach(Effect.scoped(verify), { startImmediately: true });
          const abandon = Effect.forkDetach(Fiber.interrupt(fiber)).pipe(Effect.asVoid);
          const exit = yield* restore(
            Fiber.await(fiber).pipe(Effect.timeoutOption(options.timeout)),
          ).pipe(Effect.onInterrupt(() => abandon));
          if (Option.isNone(exit)) {
            yield* abandon;
            return yield* Effect.fail(options.onTimeout());
          }
          yield* exit.value;
          const verified = verifiedHelpers.get(options.spawner) ?? new Set<string>();
          verified.add(options.helperExecutable);
          verifiedHelpers.set(options.spawner, verified);
        }),
      );
    });
