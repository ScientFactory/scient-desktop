/**
 * `feature.used` for a connector action, with its outcome, failure class and duration. Facts are
 * fixed codes and counts, never names, paths or text.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { AnalyticsService } from "../../../telemetry/AnalyticsService.ts";

type Facts = Record<string, string | number | boolean>;

export const observeFeature =
  (analytics: AnalyticsService["Service"] | undefined) =>
  (feature: string, facts: Facts = {}) =>
  <A, E extends { readonly reason?: string }, R>(
    effect: Effect.Effect<A, E, R>,
    more?: (value: A) => Facts,
  ): Effect.Effect<A, E, R> => {
    if (analytics === undefined) return effect;
    return Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (finishedAt) =>
            analytics.record("feature.used", {
              feature,
              ...facts,
              ...(Exit.isSuccess(exit)
                ? { outcome: "ok", ...more?.(exit.value) }
                : {
                    outcome: Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "error",
                    failureClass: Option.match(Cause.findErrorOption(exit.cause), {
                      onNone: () => "unknown",
                      onSome: (error) => error.reason ?? "unknown",
                    }),
                  }),
              durationMs: finishedAt - startedAt,
            }),
          ).pipe(Effect.ignoreCause()),
        ),
      ),
    );
  };
