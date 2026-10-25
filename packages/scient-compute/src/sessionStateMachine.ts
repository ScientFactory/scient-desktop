import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ComputeSessionStatus, type ComputeSessionGeneration } from "./contract.ts";

/**
 * Allow Stop during startup/restart without waiting for success. Terminal records never revive; new
 * namespaces need new sessions or history attribution becomes false. Activity can recover from
 * unresponsive when late heartbeat arrives during work.
 */
const ALLOWED_SESSION_TRANSITIONS: Readonly<
  Record<ComputeSessionStatus, ReadonlySet<ComputeSessionStatus>>
> = {
  starting: new Set(["ready", "stopping", "failed", "lost"]),
  ready: new Set(["restarting", "stopping", "failed", "lost"]),
  restarting: new Set(["ready", "stopping", "failed", "lost"]),
  stopping: new Set(["stopped", "failed", "lost"]),
  stopped: new Set(),
  failed: new Set(),
  lost: new Set(),
};

/**
 * A transition the lifecycle does not allow.
 *
 * Typed for the same reason as its execution counterpart: recovery reads a
 * stored status back, so an impossible pair is data to report rather than a
 * defect to crash on.
 */
export class InvalidComputeSessionTransitionError extends Schema.TaggedError<InvalidComputeSessionTransitionError>()(
  "InvalidComputeSessionTransitionError",
  {
    current: ComputeSessionStatus,
    next: ComputeSessionStatus,
  },
) {
  override get message(): string {
    return `Compute session status cannot transition from '${this.current}' to '${this.next}'.`;
  }
}

export function transitionComputeSessionStatus(
  current: ComputeSessionStatus,
  next: ComputeSessionStatus,
): Effect.Effect<ComputeSessionStatus, InvalidComputeSessionTransitionError> {
  if (current === next) return Effect.succeed(current);
  if (!ALLOWED_SESSION_TRANSITIONS[current].has(next)) {
    return Effect.fail(new InvalidComputeSessionTransitionError({ current, next }));
  }
  return Effect.succeed(next);
}

/**
 * Separate stale from ahead generation: stale is a user-visible moved session; ahead cannot reflect
 * observed truth and indicates a defect requiring a different report.
 */
export type ComputeGenerationCheck =
  | { readonly _tag: "current" }
  | { readonly _tag: "stale"; readonly currentGeneration: ComputeSessionGeneration }
  | { readonly _tag: "ahead"; readonly currentGeneration: ComputeSessionGeneration };

export function checkComputeSessionGeneration(
  currentGeneration: ComputeSessionGeneration,
  expectedGeneration: ComputeSessionGeneration,
): ComputeGenerationCheck {
  if (expectedGeneration === currentGeneration) return { _tag: "current" };
  if (expectedGeneration < currentGeneration) return { _tag: "stale", currentGeneration };
  return { _tag: "ahead", currentGeneration };
}
