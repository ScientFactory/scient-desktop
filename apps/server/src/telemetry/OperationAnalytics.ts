import type { ScientLatexBuildFailureClass } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { AnalyticsService } from "./AnalyticsService.ts";
import type { ComputeCaptureSummary } from "../scient/compute/ComputeCaptureStatus.ts";
import {
  captureRejectionAttribution,
  latexBuildAttribution,
  type FailureAttribution,
} from "./FailureAttribution.ts";

export interface OperationObservation {
  /** Opaque local correlation only. Never part of the event payload. */
  readonly key: string;
  readonly operationKind: "compute-run" | "compute-artifact" | "latex-build";
  readonly status: "active" | "completed" | "failed" | "cancelled" | "skipped";
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly trigger?: "user" | "agent" | "automation" | "other";
  readonly failureClass?: "process-crash" | "unknown" | ScientLatexBuildFailureClass;
  /** The compute language, such as `python` or `r`; a closed runtime id, never a path. */
  readonly language?: string;
  readonly capture?: ComputeCaptureSummary;
  /** Who a failure belongs to; read only on failed outcomes. */
  readonly attribution?: FailureAttribution;
  readonly actor?: "user" | "agent";
  /** How the run entered Compute: the Console, a file, a selection, a notebook cell or Run. */
  readonly entry?: "console" | "file" | "selection" | "cell" | "run-file";
  readonly runtimeSource?: string;
}

function failureAttribution(input: OperationObservation): FailureAttribution | undefined {
  if (input.status !== "failed") return undefined;
  if (input.attribution !== undefined) return input.attribution;
  if (input.operationKind === "latex-build")
    return latexBuildAttribution(
      input.failureClass === "process-crash" || input.failureClass === "unknown"
        ? undefined
        : input.failureClass,
    );
  if (input.operationKind === "compute-artifact") {
    const reason = input.capture?.captureReason;
    return captureRejectionAttribution(reason === "none" ? undefined : reason);
  }
  return { failureOwner: "unknown", failureCategory: "unknown" };
}

/** Observe durable outcomes, not RPC acceptance or polling. No raw inputs/results. */
export const makeOperationAnalytics = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(AnalyticsService);
  if (Option.isNone(service)) return (_input: OperationObservation) => Effect.void;
  const analytics = service.value;
  const operations = new Map<string, boolean>();
  let epoch = yield* analytics.collectionEpoch.pipe(Effect.catchDefect(() => Effect.succeed(-1)));
  return (input: OperationObservation) =>
    Effect.gen(function* () {
      const currentEpoch = yield* analytics.collectionEpoch;
      if (currentEpoch !== epoch) {
        operations.clear();
        epoch = currentEpoch;
      }
      const status = yield* analytics.status;
      if (!status.available || status.consent === "off") {
        operations.clear();
        return;
      }
      const previous = operations.get(input.key);
      if (previous === true || (previous === false && input.status === "active")) return;
      if (operations.size >= 1_000 && !operations.has(input.key)) {
        const oldest = operations.keys().next().value;
        if (oldest !== undefined) operations.delete(oldest);
      }
      operations.set(input.key, input.status !== "active");
      // Restored terminal state, or a completion whose start preceded consent,
      // is not evidence of a new measured operation.
      if (previous === undefined && input.status !== "active") return;
      yield* analytics.record(
        `scient.operation.${input.status === "active" ? "started" : input.status}`,
        {
          operationKind: input.operationKind,
          trigger: input.trigger ?? "other",
          durationMs:
            input.finishedAt === undefined ? undefined : input.finishedAt - input.startedAt,
          failureClass: input.failureClass ?? "unknown",
          ...(input.language === undefined ? {} : { language: input.language }),
          ...failureAttribution(input),
          ...(input.actor === undefined ? {} : { actor: input.actor }),
          ...(input.entry === undefined ? {} : { entry: input.entry }),
          ...(input.runtimeSource === undefined ? {} : { runtimeSource: input.runtimeSource }),
          ...(input.operationKind === "compute-artifact"
            ? { captureSchemaVersion: 2, captureSource: "run-file" }
            : {}),
          ...input.capture,
        },
      );
    }).pipe(Effect.ignoreCause());
});

/** For operations whose Effect completion really is the product outcome. */
export const observeAnalyticsEffect = Effect.fn("OperationAnalytics.observeAnalyticsEffect")(
  function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    measurement:
      | { readonly kind: "pdf-export"; readonly trigger: "agent" }
      | { readonly kind: "server-startup" }
      | { readonly kind: "provider-sign-out"; readonly provider: string; readonly source: string },
  ): Effect.fn.Return<A, E, R> {
    const service = yield* Effect.serviceOption(AnalyticsService);
    if (Option.isNone(service)) return yield* effect;
    const analytics = service.value;
    const observation = yield* Effect.gen(function* () {
      const status = yield* analytics.status;
      if (!status.available || status.consent === "off") return null;
      return { epoch: yield* analytics.collectionEpoch };
    }).pipe(Effect.catchDefect(() => Effect.succeed(null)));
    // A broken observer must never prevent or retry the actual product operation.
    if (observation === null) return yield* effect;
    const { epoch } = observation;
    const startedAt = yield* Clock.currentTimeMillis;
    const record = Effect.fn("OperationAnalytics.record")(
      function* (outcome: "started" | "completed" | "failed" | "cancelled", durationMs?: number) {
        if ((yield* analytics.collectionEpoch) !== epoch) return;
        if (measurement.kind === "server-startup") {
          yield* analytics.record("app.health", {
            component: "server",
            operation: "startup",
            outcome: outcome === "cancelled" ? "abnormal" : outcome,
            durationMs,
          });
        } else if (measurement.kind === "provider-sign-out") {
          yield* analytics.record(`provider.lifecycle.${outcome}`, {
            provider: measurement.provider,
            source: measurement.source,
            action: "sign-out",
            durationMs,
          });
        } else {
          yield* analytics.record(`scient.operation.${outcome}`, {
            operationKind: measurement.kind,
            trigger: measurement.trigger,
            durationMs,
            reviewRequired: true,
          });
        }
      },
      (effect) => effect.pipe(Effect.ignoreCause()),
    );
    yield* record("started");
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const finishedAt = yield* Clock.currentTimeMillis;
          yield* record(
            Exit.isSuccess(exit)
              ? "completed"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "cancelled"
                : "failed",
            finishedAt - startedAt,
          );
        }).pipe(Effect.ignoreCause()),
      ),
    );
  },
);
