import * as Schema from "effect/Schema";

import { ExecutionStatus } from "./contract.ts";

const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionStatus, ReadonlySet<ExecutionStatus>>> = {
  queued: new Set(["starting", "cancelled", "lost"]),
  starting: new Set(["running", "failed", "cancelled", "lost"]),
  running: new Set(["succeeded", "failed", "cancelled", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};

export class InvalidExecutionTransitionError extends Schema.TaggedError<InvalidExecutionTransitionError>()(
  "InvalidExecutionTransitionError",
  { current: ExecutionStatus, next: ExecutionStatus },
) {
  override get message(): string {
    return `Execution status cannot transition from '${this.current}' to '${this.next}'.`;
  }
}

export function transitionExecutionStatus(
  current: ExecutionStatus,
  next: ExecutionStatus,
): ExecutionStatus {
  if (current === next) return current;
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new InvalidExecutionTransitionError({ current, next });
  }
  return next;
}
