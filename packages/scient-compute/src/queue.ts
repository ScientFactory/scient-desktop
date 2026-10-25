import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputeExecutionId } from "./contract.ts";
import { Count } from "./primitives.ts";

/**
 * Serialize one namespace so dependent code cannot interleave shared-state effects. Reject stale
 * generations before queue admission and drain on restart; entries need no second generation field
 * that could disagree with the session record.
 */

/**
 * Bound pending executions so a stuck kernel cannot grow memory/backlog without limit. Allow a
 * useful cell burst while keeping the queue small enough to inspect.
 */
export const MAXIMUM_PENDING_COMPUTE_EXECUTIONS = 16;

export interface ComputeQueueState {
  readonly active: ComputeExecutionId | null;
  readonly pending: ReadonlyArray<ComputeExecutionId>;
}

export const EMPTY_COMPUTE_QUEUE: ComputeQueueState = { active: null, pending: [] };

/**
 * Return the numeric queue limit in a typed refusal; clients must not parse prose to explain how
 * many executions are already waiting.
 */
export class ComputeQueueFullError extends Schema.TaggedError<ComputeQueueFullError>()(
  "ComputeQueueFullError",
  {
    limit: Count,
    pending: Count,
  },
) {
  override get message(): string {
    return `The session already has ${this.pending} executions waiting, which is its limit of ${this.limit}.`;
  }
}

/** Where an execution sits, counting the running one as zero. */
export function computeQueuePositionOf(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): number | null {
  if (state.active === executionId) return 0;
  const index = state.pending.indexOf(executionId);
  if (index < 0) return null;
  return state.active === null ? index : index + 1;
}

export function computeQueueDepth(state: ComputeQueueState): number {
  return (state.active === null ? 0 : 1) + state.pending.length;
}

/**
 * Accepts an execution, or refuses because too many are already waiting.
 *
 * A resubmitted identifier keeps its place rather than being appended again.
 * Two entries for one execution would make the queue disagree with the record,
 * and a retried command must not cost a user a second slot.
 */
export function admitComputeExecution(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): Effect.Effect<{ state: ComputeQueueState; position: number }, ComputeQueueFullError> {
  const existing = computeQueuePositionOf(state, executionId);
  if (existing !== null) return Effect.succeed({ state, position: existing });
  if (state.pending.length >= MAXIMUM_PENDING_COMPUTE_EXECUTIONS) {
    return Effect.fail(
      new ComputeQueueFullError({
        limit: MAXIMUM_PENDING_COMPUTE_EXECUTIONS,
        pending: state.pending.length,
      }),
    );
  }
  const next: ComputeQueueState = {
    active: state.active,
    pending: [...state.pending, executionId],
  };
  return Effect.succeed({
    state: next,
    // Non-null by construction: the entry was just appended.
    position: computeQueuePositionOf(next, executionId) ?? next.pending.length,
  });
}

/**
 * Promotes the head of the queue, if nothing is running.
 *
 * Returns null rather than failing when there is nothing to promote, because
 * both reasons -- something is already running, nothing is waiting -- are
 * ordinary and the caller does the same thing in either case.
 */
export function startNextComputeExecution(state: ComputeQueueState): {
  readonly state: ComputeQueueState;
  readonly started: ComputeExecutionId | null;
} {
  if (state.active !== null) return { state, started: null };
  const [head, ...rest] = state.pending;
  if (head === undefined) return { state, started: null };
  return { state: { active: head, pending: rest }, started: head };
}

/**
 * Ignore completion IDs that are no longer active. Late reports after namespace movement are
 * expected races, not reasons to fail another command.
 */
export function finishComputeExecution(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): ComputeQueueState {
  if (state.active !== executionId) return state;
  return { active: null, pending: state.pending };
}

/**
 * Distinguish removed pending work from active work: pending cancels by forgetting, active requires
 * runtime interruption. Collapsing them leaks running code or signals work that never started.
 */
export function cancelComputeExecution(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): {
  readonly state: ComputeQueueState;
  readonly removed: "active" | "pending" | null;
} {
  if (state.active === executionId) {
    return { state, removed: "active" };
  }
  if (!state.pending.includes(executionId)) return { state, removed: null };
  return {
    state: {
      active: state.active,
      pending: state.pending.filter((candidate) => candidate !== executionId),
    },
    removed: "pending",
  };
}

/**
 * Queued code targets the ending namespace and must not run after restart. Return drained entries
 * for terminal cancellation records rather than silently leaving holes in durable history.
 */
export function drainComputeQueue(state: ComputeQueueState): {
  readonly state: ComputeQueueState;
  readonly active: ComputeExecutionId | null;
  readonly cancelled: ReadonlyArray<ComputeExecutionId>;
} {
  return { state: EMPTY_COMPUTE_QUEUE, active: state.active, cancelled: state.pending };
}

/** The pending entries with the positions a client should be shown. */
export function computeQueueEntries(
  state: ComputeQueueState,
): ReadonlyArray<{ readonly executionId: ComputeExecutionId; readonly position: number }> {
  const offset = state.active === null ? 0 : 1;
  return state.pending.map((executionId, index) => ({ executionId, position: index + offset }));
}
