import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Stream from "effect/Stream";

import type {
  ExecutionProcessOutput,
  ExecutionProcessHandle,
  ExecutionProcessPort,
  ExecutionProcessRequest,
} from "./contract.ts";

export interface SimulatedExecutionStep {
  readonly output: ExecutionProcessOutput;
}

export interface SimulatedExecutionPlan {
  readonly steps: ReadonlyArray<SimulatedExecutionStep>;
  readonly exitCode: number;
}

/** Deterministic cross-domain process double shared by every runtime adapter test. */
export function createSimulatedExecutionPort(
  resolvePlan: (request: ExecutionProcessRequest) => SimulatedExecutionPlan,
): ExecutionProcessPort {
  return {
    start(request: ExecutionProcessRequest) {
      const plan = resolvePlan(request);
      const cancelled = MutableRef.make(false);
      return Effect.succeed({
        output: Stream.fromIterable(plan.steps).pipe(
          Stream.takeWhile(() => !MutableRef.get(cancelled)),
          Stream.map((step) => step.output),
        ),
        exitCode: Effect.sync(() => (MutableRef.get(cancelled) ? 130 : plan.exitCode)),
        cancel: Effect.sync(() => MutableRef.set(cancelled, true)),
      } satisfies ExecutionProcessHandle);
    },
  };
}
