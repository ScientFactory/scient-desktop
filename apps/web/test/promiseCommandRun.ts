import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/** Whatever the fake answered as its failure; the code under test reads it back from the cause. */
type FakeCommandFailure = string | object | undefined;

/**
 * An atom command fake written as a Promise of its settled result (`{ _tag, value | cause }`),
 * run as commands now run: an Effect that succeeds with the value or fails with the cause.
 * Any other answer counts as the success value.
 */
export const promiseCommandRun =
  <Args extends ReadonlyArray<unknown>>(answer: (...args: Args) => unknown) =>
  (...args: Args) =>
    Effect.promise(async () => answer(...args)).pipe(
      Effect.flatMap((settled: unknown) => {
        if (typeof settled !== "object" || settled === null || !("_tag" in settled)) {
          return Effect.succeed(settled);
        }
        const result = settled as { readonly _tag: unknown; value?: unknown; cause?: unknown };
        if (result._tag === "Success") return Effect.succeed(result.value);
        if (result._tag !== "Failure") return Effect.succeed(settled);
        return Effect.failCause(
          (Cause.isCause(result.cause)
            ? result.cause
            : Cause.fail(result.cause)) as Cause.Cause<FakeCommandFailure>,
        );
      }),
    );
