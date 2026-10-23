import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Tracer from "effect/Tracer";
import type { LatexBuildInput, LatexBuildService } from "./LatexBuildService.ts";

class BuildCompletions extends Context.Service<
  BuildCompletions,
  { readonly changes: PubSub.PubSub<void> }
>()("t3/scient/latex/latexBuildCompletion.testkit/BuildCompletions") {}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

export const observeLatexBuilds = Effect.fn("latexBuildCompletion.testkit.observe")(function* () {
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const underlying = yield* Tracer.Tracer;
  const tracer = Tracer.make({
    context: underlying.context,
    span(options) {
      const span = underlying.span(options);
      if (options.name === "LatexBuildService.runBuildLoop") {
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          PubSub.publishUnsafe(changes, undefined);
        };
      }
      return span;
    },
  });
  return Layer.merge(
    Layer.succeed(Tracer.Tracer, tracer),
    Layer.succeed(BuildCompletions, { changes }),
  );
});

export const awaitLatexBuildTerminal = Effect.fn("latexBuildCompletion.testkit.awaitTerminal")(
  function* (service: LatexBuildService["Service"], input: LatexBuildInput) {
    const { changes } = yield* BuildCompletions;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading so completion cannot land between the read and wait.
        // Each document waiter owns a subscription; another build cannot steal its receipt.
        const subscription = yield* PubSub.subscribe(changes);
        for (;;) {
          const snapshot = yield* service.status(input);
          if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
          yield* PubSub.take(subscription);
        }
      }),
    );
  },
);
