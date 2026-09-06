import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AnalyticsService } from "./AnalyticsService.ts";

type ComputeOutputObservation = { readonly key: string } & (
  | { readonly phase: "started"; readonly startedAt: number }
  | { readonly phase: "output"; readonly retained: boolean }
  | {
      readonly phase: "finished";
      readonly finishedAt?: number;
    }
);

/** Coalesce retained rich outputs into one capture outcome per admitted execution.
 * Keys and flags are local-only; no output content or extra persistence is read.
 */
export const makeComputeOutputAnalytics = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(AnalyticsService);
  if (Option.isNone(service)) return (_input: ComputeOutputObservation) => Effect.void;
  const analytics = service.value;
  const active = new Map<string, { startedAt: number; retained: boolean; failed: boolean }>();
  let epoch: number | undefined;
  return (input: ComputeOutputObservation) =>
    Effect.gen(function* () {
      const currentEpoch = yield* analytics.collectionEpoch;
      if (currentEpoch !== epoch) {
        active.clear();
        epoch = currentEpoch;
      }
      const status = yield* analytics.status;
      if (!status.available || status.consent === "off") {
        active.clear();
        return;
      }
      const observation = active.get(input.key);
      if (input.phase === "started") {
        if (observation !== undefined) return;
        if (active.size >= 1_000) return;
        active.set(input.key, { startedAt: input.startedAt, retained: false, failed: false });
        yield* analytics.record("scient.operation.started", {
          operationKind: "compute-artifact",
          trigger: "other",
        });
        return;
      }
      // No replay of restored work, untracked starts, post-terminal updates or pre-consent work.
      if (observation === undefined) return;
      if (input.phase === "output") {
        observation.retained ||= input.retained;
        observation.failed ||= !input.retained;
        return;
      }
      active.delete(input.key);
      const outcome = observation.failed
        ? "failed"
        : observation.retained
          ? "completed"
          : "skipped";
      yield* analytics.record(`scient.operation.${outcome}`, {
        operationKind: "compute-artifact",
        trigger: "other",
        durationMs:
          input.finishedAt === undefined ? undefined : input.finishedAt - observation.startedAt,
        failureClass: "unknown",
      });
    }).pipe(Effect.ignoreCause());
});
