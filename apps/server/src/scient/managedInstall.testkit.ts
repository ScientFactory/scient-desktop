import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";

// The existing operation span encloses cleanup and terminal publication.
export const observeManagedInstall = Effect.fn("managedInstall.testkit.observe")(function* (
  spanName: string,
) {
  const completions = yield* Effect.acquireRelease(Queue.make<void>(), Queue.shutdown);
  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      if (options.name === spanName) {
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          Queue.offerUnsafe(completions, undefined);
        };
      }
      return span;
    },
  });
  return {
    layer: Layer.succeed(Tracer.Tracer, tracer),
    awaitCompletion: Queue.take(completions),
  };
});
