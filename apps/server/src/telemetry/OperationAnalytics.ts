import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { AnalyticsService } from "./AnalyticsService.ts";

export interface OperationObservation {
  /** Opaque local correlation only. Never part of the event payload. */
  readonly key: string;
  readonly operationKind: "compute-run" | "compute-artifact" | "latex-build";
  readonly status: "active" | "completed" | "failed" | "cancelled" | "skipped";
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly trigger?: "user" | "agent" | "automation" | "other";
  readonly failureClass?: "process-crash" | "unknown";
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
        },
      );
    }).pipe(Effect.ignoreCause());
});

/** For operations whose Effect completion really is the product outcome. */
export function observeAnalyticsEffect<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  measurement:
    | { readonly kind: "pdf-export"; readonly trigger: "agent" }
    | { readonly kind: "server-startup" }
    | { readonly kind: "provider-sign-out"; readonly provider: string; readonly source: string },
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
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
    const record = (
      outcome: "started" | "completed" | "failed" | "cancelled",
      durationMs?: number,
    ) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.ignoreCause());
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
  });
}
