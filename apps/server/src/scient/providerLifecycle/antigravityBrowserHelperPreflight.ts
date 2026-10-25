/**
 * Cache success by helper executable/launch settings to avoid Windows synchronous spawn stalls;
 * retry failures next sign-in. Prove the browser helper prints its marker without opening a
 * browser. Bound timeout response separately from background teardown and forced-kill fallback.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - A synchronous digest keys an in-memory cache.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Keyed by the spawner so a server process, which has one, verifies each
// helper once, while a test that substitutes a spawner sees its own runs.
const verifiedHelpers = new WeakMap<object, Set<string>>();
const startupVariables = new Set(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);
const TEARDOWN_BOUND = "5 seconds";

interface PreflightChildSlot {
  current: ChildProcessSpawner.ChildProcessHandle | undefined;
}

const PreflightChild = Context.Reference<PreflightChildSlot | undefined>(
  "t3/scient/providerLifecycle/antigravityBrowserHelperPreflight/PreflightChild",
  { defaultValue: () => undefined },
);

/** Lets a timed-out preflight force-kill the helper it started. */
export const recordAntigravityPreflightChild = Effect.fn(
  "antigravityBrowserHelperPreflight.recordAntigravityPreflightChild",
)(function* (child: ChildProcessSpawner.ChildProcessHandle) {
  const slot = yield* PreflightChild;
  if (slot) slot.current = child;
});

/** Interrupts a timed-out preflight in the background, never waiting without a bound. */
const abandonPreflight = Effect.fn("antigravityBrowserHelperPreflight.abandonPreflight")(
  function* (fiber: Fiber.Fiber<unknown, unknown>, slot: PreflightChildSlot) {
    const settled = yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption(TEARDOWN_BOUND));
    if (Option.isSome(settled)) return;
    if (slot.current) {
      yield* slot.current
        .kill({ killSignal: "SIGKILL" })
        .pipe(Effect.timeoutOption(TEARDOWN_BOUND), Effect.ignore);
    }
    yield* Effect.logDebug("The Antigravity browser-helper preflight teardown did not finish.");
  },
  (effect) => effect.pipe(Effect.forkDetach, Effect.asVoid),
);

/**
 * A digest of the executable and every spelling of the startup variables, so the
 * cache never holds their values. Windows keys are case-insensitive and which of
 * several spellings a child sees depends on the platform, so every spelling and
 * value counts: changing any of them checks the helper again.
 */
function helperKey(executable: string, environment: NodeJS.ProcessEnv): string {
  const startup = Object.entries(environment)
    .filter(([key, value]) => value !== undefined && startupVariables.has(key.toUpperCase()))
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([executable, startup]))
    .digest("hex");
}

export const verifyAntigravityBrowserHelperOnce =
  <E2>(options: {
    readonly spawner: object;
    readonly helperExecutable: string;
    /** The environment the agent launches the helper with. */
    readonly environment: NodeJS.ProcessEnv;
    readonly timeout: Duration.Input;
    readonly onTimeout: () => E2;
  }) =>
  <E, R>(verify: Effect.Effect<void, E, R>): Effect.Effect<void, E | E2, Exclude<R, Scope.Scope>> =>
    Effect.suspend(() => {
      const key = helperKey(options.helperExecutable, options.environment);
      if (verifiedHelpers.get(options.spawner)?.has(key)) return Effect.void;
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Started immediately, so the bound applies to the helper's run, not to
          // creating its process.
          const slot: PreflightChildSlot = { current: undefined };
          const fiber = yield* Effect.forkDetach(
            Effect.scoped(verify).pipe(Effect.provideService(PreflightChild, slot)),
            { startImmediately: true },
          );
          const abandon = abandonPreflight(fiber, slot);
          const exit = yield* restore(
            Fiber.await(fiber).pipe(Effect.timeoutOption(options.timeout)),
          ).pipe(Effect.onInterrupt(() => abandon));
          if (Option.isNone(exit)) {
            yield* abandon;
            return yield* Effect.fail(options.onTimeout());
          }
          yield* exit.value;
          const verified = verifiedHelpers.get(options.spawner) ?? new Set<string>();
          verified.add(key);
          verifiedHelpers.set(options.spawner, verified);
        }),
      );
    });
