import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TERMINAL_COMPUTE_EXECUTION_STATUSES, type ComputeExecutionStatus } from "./contract.ts";
import {
  InvalidComputeExecutionTransitionError,
  transitionComputeExecutionStatus,
} from "./executionStateMachine.ts";

const transition = transitionComputeExecutionStatus;

// `flip` turns the refusal into the value under test, so a transition that
// wrongly succeeds fails the test instead of being asserted about.
const refusal = (
  current: ComputeExecutionStatus,
  next: ComputeExecutionStatus,
): Effect.Effect<InvalidComputeExecutionTransitionError, ComputeExecutionStatus> =>
  Effect.flip(transitionComputeExecutionStatus(current, next));

// Stated independently of the implementation on purpose: a table derived from
// the one under test would agree with any mistake in it.
const STATUSES: ReadonlyArray<ComputeExecutionStatus> = [
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "interrupting",
  "cancelled",
  "lost",
];

const LEGAL: ReadonlyArray<readonly [ComputeExecutionStatus, ComputeExecutionStatus]> = [
  ["queued", "submitting"],
  ["queued", "cancelled"],
  ["submitting", "running"],
  ["submitting", "failed"],
  ["submitting", "interrupting"],
  ["submitting", "cancelled"],
  ["submitting", "lost"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "interrupting"],
  ["running", "cancelled"],
  ["running", "lost"],
  ["interrupting", "running"],
  ["interrupting", "cancelled"],
  ["interrupting", "succeeded"],
  ["interrupting", "failed"],
  ["interrupting", "lost"],
];

const isLegal = (current: ComputeExecutionStatus, next: ComputeExecutionStatus): boolean =>
  LEGAL.some(([from, to]) => from === current && to === next);

describe("compute execution state machine", () => {
  it.effect("permits exactly the transitions the lifecycle allows", () =>
    Effect.gen(function* () {
      for (const current of STATUSES) {
        for (const next of STATUSES) {
          if (current === next) {
            expect(yield* transition(current, next)).toBe(current);
            continue;
          }
          if (isLegal(current, next)) {
            expect(yield* transition(current, next)).toBe(next);
            continue;
          }
          expect((yield* refusal(current, next))._tag).toBe(
            "InvalidComputeExecutionTransitionError",
          );
        }
      }
    }),
  );

  it.effect("leaves every terminal status without a successor", () =>
    Effect.gen(function* () {
      for (const terminal of TERMINAL_COMPUTE_EXECUTION_STATUSES) {
        for (const next of STATUSES) {
          if (next === terminal) continue;
          expect((yield* refusal(terminal, next)).current).toBe(terminal);
        }
      }
    }),
  );

  it.effect("reports a refusal as a typed failure rather than a defect", () =>
    Effect.gen(function* () {
      const error = yield* refusal("succeeded", "running");

      expect(error.message).toBe(
        "Compute execution status cannot transition from 'succeeded' to 'running'.",
      );
      expect([error.current, error.next]).toEqual(["succeeded", "running"]);
    }),
  );
});
