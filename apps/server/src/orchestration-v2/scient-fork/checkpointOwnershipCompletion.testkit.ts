import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";

export const observeCheckpointOwnership = Effect.fn(
  "checkpointOwnershipCompletion.testkit.observe",
)(function* () {
  const recovered = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const reconciled = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const underlying = yield* Tracer.Tracer;
  const tracer = Tracer.make({
    context: underlying.context,
    span(options) {
      const span = underlying.span(options);
      const receipt =
        options.name === "ForkCheckpointOwnership.recover"
          ? recovered
          : options.name === "ForkCheckpointOwnership.reconcile"
            ? reconciled
            : undefined;
      if (receipt !== undefined) {
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          Queue.offerUnsafe(receipt, undefined);
        };
      }
      return span;
    },
  });
  return {
    layer: Layer.succeed(Tracer.Tracer, tracer),
    recovered: Queue.take(recovered),
    reconciled: Queue.take(reconciled),
  };
});
