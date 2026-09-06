import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  SourceImportObserver,
  SourceImportOutcome,
} from "../scient/sources/SourceImportObservation.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

/** A Promise bridge for the existing source coordinator, not a second job owner. */
export const makeSourceImportAnalytics = Effect.fn("makeSourceImportAnalytics")(function* (
  trigger: "user" | "agent",
): Effect.fn.Return<SourceImportObserver | undefined> {
  const service = yield* Effect.serviceOption(AnalyticsService);
  if (Option.isNone(service)) return undefined;
  const analytics = service.value;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  return () =>
    runPromise(
      Effect.gen(function* () {
        const status = yield* analytics.status;
        if (!status.available || status.consent === "off") return undefined;
        const epoch = yield* analytics.collectionEpoch;
        const startedAt = yield* Clock.currentTimeMillis;
        yield* analytics.record("scient.operation.started", {
          operationKind: "source-import",
          trigger,
        });
        let finished = false;
        return (outcome: SourceImportOutcome) =>
          runPromise(
            Effect.gen(function* () {
              if (finished) return;
              finished = true;
              if ((yield* analytics.collectionEpoch) !== epoch) return;
              const current = yield* analytics.status;
              if (!current.available || current.consent === "off") return;
              const finishedAt = yield* Clock.currentTimeMillis;
              yield* analytics.record(
                `scient.operation.${outcome === "imported" ? "completed" : outcome}`,
                {
                  operationKind: "source-import",
                  trigger,
                  durationMs: finishedAt - startedAt,
                  ...(outcome === "failed" ? { failureClass: "unknown" } : {}),
                  reviewRequired: trigger === "agent",
                },
              );
            }).pipe(Effect.ignoreCause()),
          );
      }),
    );
});
