import { KEEP_AWAKE_LEASE_MS, type KeepAwakeExecution } from "@t3tools/contracts";

export interface KeepAwakeExecutionLease extends KeepAwakeExecution {
  readonly lastProgressAt: number;
}

export function observeKeepAwakeExecution(
  previous: readonly KeepAwakeExecutionLease[],
  execution: readonly KeepAwakeExecution[],
  observedAt: number,
): readonly KeepAwakeExecutionLease[] {
  const byKey = new Map(previous.map((entry) => [entry.key, entry]));
  return execution.map((entry) => {
    const last = byKey.get(entry.key);
    return {
      ...entry,
      lastProgressAt:
        last?.progressToken === entry.progressToken ? last.lastProgressAt : observedAt,
    };
  });
}

export function executionKeepsAwake(execution: readonly KeepAwakeExecutionLease[], now: number) {
  return execution.some(
    (entry) =>
      entry.needsAwake &&
      (entry.health === "connected" || entry.lastProgressAt + KEEP_AWAKE_LEASE_MS > now),
  );
}
