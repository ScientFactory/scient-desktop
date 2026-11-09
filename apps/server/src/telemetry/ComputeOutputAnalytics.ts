import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AnalyticsService } from "./AnalyticsService.ts";
import type {
  ComputeCaptureReason,
  ComputeProjectCaptureStatus,
} from "../scient/compute/ComputeCaptureStatus.ts";

type ComputeOutputObservation = { readonly key: string } & (
  | { readonly phase: "started"; readonly startedAt: number }
  | { readonly phase: "output"; readonly retained: boolean; readonly reason?: ComputeCaptureReason }
  | { readonly phase: "coverage"; readonly capture: ComputeProjectCaptureStatus }
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
  const active = new Map<
    string,
    {
      startedAt: number;
      retained: number;
      rejected: number;
      coverage: ComputeProjectCaptureStatus["coverage"];
      coverageReason?: ComputeCaptureReason | undefined;
      rejectionReason?: ComputeCaptureReason | undefined;
    }
  >();
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
        active.set(input.key, {
          startedAt: input.startedAt,
          retained: 0,
          rejected: 0,
          coverage: "unavailable",
          coverageReason: "observation-unavailable",
        });
        yield* analytics.record("scient.operation.started", {
          operationKind: "compute-artifact",
          trigger: "other",
          captureSchemaVersion: 2,
          captureSource: "interactive",
        });
        return;
      }
      // No replay of restored work, untracked starts, post-terminal updates or pre-consent work.
      if (observation === undefined) return;
      if (input.phase === "coverage") {
        observation.coverage = input.capture.coverage;
        observation.coverageReason = input.capture.coverageReason;
        observation.rejected = Math.min(1_000, observation.rejected + input.capture.rejectedCount);
        observation.rejectionReason ??= input.capture.rejectionReason;
        return;
      }
      if (input.phase === "output") {
        if (input.retained) observation.retained = Math.min(1_000, observation.retained + 1);
        else {
          observation.rejected = Math.min(1_000, observation.rejected + 1);
          observation.rejectionReason ??= input.reason ?? "persistence-failed";
        }
        return;
      }
      active.delete(input.key);
      const outcome =
        observation.rejected > 0 ? "failed" : observation.retained > 0 ? "completed" : "skipped";
      yield* analytics.record(`scient.operation.${outcome}`, {
        operationKind: "compute-artifact",
        trigger: "other",
        durationMs:
          input.finishedAt === undefined ? undefined : input.finishedAt - observation.startedAt,
        failureClass: "unknown",
        captureSchemaVersion: 2,
        captureSource: "interactive",
        captureOutcome:
          observation.rejected > 0
            ? observation.retained > 0
              ? "partial"
              : "failed"
            : observation.retained > 0
              ? "retained"
              : observation.coverage === "complete"
                ? "none"
                : "unobserved",
        captureCoverage: observation.coverage,
        captureReason: observation.rejectionReason ?? observation.coverageReason ?? "none",
        retainedOutputCount: observation.retained,
        rejectedOutputCount: observation.rejected,
      });
    }).pipe(Effect.ignoreCause());
});
