import type { ExecutionStatus } from "./contract.ts";

const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionStatus, ReadonlySet<ExecutionStatus>>> = {
  queued: new Set(["starting", "cancelled", "lost"]),
  starting: new Set(["running", "failed", "cancelled", "lost"]),
  running: new Set(["succeeded", "failed", "cancelled", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};

export class InvalidExecutionTransitionError extends Error {
  readonly current: ExecutionStatus;
  readonly next: ExecutionStatus;

  constructor(current: ExecutionStatus, next: ExecutionStatus) {
    super(`Execution status cannot transition from '${current}' to '${next}'.`);
    this.name = "InvalidExecutionTransitionError";
    this.current = current;
    this.next = next;
  }
}

export function transitionExecutionStatus(
  current: ExecutionStatus,
  next: ExecutionStatus,
): ExecutionStatus {
  if (current === next) return current;
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new InvalidExecutionTransitionError(current, next);
  }
  return next;
}
