import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ComputeExecutionStatus } from "./contract.ts";

/**
 * Queued work cancels, never becomes lost. Submitting can be interrupted; interrupting may still
 * succeed/fail because a request is not its result. Rejected interrupts return running, namespace
 * destruction cancels directly, and any submitted work may become lost when outcome evidence
 * disappears.
 */
const ALLOWED_EXECUTION_TRANSITIONS: Readonly<
  Record<ComputeExecutionStatus, ReadonlySet<ComputeExecutionStatus>>
> = {
  queued: new Set(["submitting", "cancelled"]),
  submitting: new Set(["running", "failed", "interrupting", "cancelled", "lost"]),
  running: new Set(["succeeded", "failed", "interrupting", "cancelled", "lost"]),
  interrupting: new Set(["running", "cancelled", "succeeded", "failed", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};

/**
 * A transition the lifecycle does not allow.
 *
 * It is a typed failure rather than a thrown defect because the current status
 * is often read back from durable storage, and a stored status that cannot
 * reach the one an event asks for is bad data, not unreachable code.
 */
export class InvalidComputeExecutionTransitionError extends Schema.TaggedError<InvalidComputeExecutionTransitionError>()(
  "InvalidComputeExecutionTransitionError",
  {
    current: ComputeExecutionStatus,
    next: ComputeExecutionStatus,
  },
) {
  override get message(): string {
    return `Compute execution status cannot transition from '${this.current}' to '${this.next}'.`;
  }
}

export function transitionComputeExecutionStatus(
  current: ComputeExecutionStatus,
  next: ComputeExecutionStatus,
): Effect.Effect<ComputeExecutionStatus, InvalidComputeExecutionTransitionError> {
  if (current === next) return Effect.succeed(current);
  if (!ALLOWED_EXECUTION_TRANSITIONS[current].has(next)) {
    return Effect.fail(new InvalidComputeExecutionTransitionError({ current, next }));
  }
  return Effect.succeed(next);
}
