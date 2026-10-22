import { assert } from "@effect/vitest";
import type { TestContext } from "vite-plus/test";
import * as Effect from "effect/Effect";

export const measureEffectBenchmark = Effect.fn("forkBenchmark.testkit.measure")(function* <
  A,
  E,
  R,
>(bench: TestContext["bench"], name: string, operation: Effect.Effect<A, E, R>) {
  const run = Effect.runPromiseWith(yield* Effect.context<R>());
  const completions: Array<A> = [];
  let retired = Promise.resolve();
  const measured = yield* Effect.promise((signal) => {
    const pending = bench(name, { async: true }, async () => {
      completions.push(await run(operation, { signal }));
    }).run({ time: 0, iterations: 1, warmup: false, retainSamples: true });
    retired = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }).pipe(
    // An interrupted measurement must retire its task before its operation's scope closes.
    Effect.onInterrupt(() => Effect.promise(() => retired)),
  );
  assert.lengthOf(completions, 1);
  assert.equal(measured.latency.samples?.length, 1);
  return [completions[0]!, measured.latency.mean] as const;
});
