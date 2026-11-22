// @effect-diagnostics nodeBuiltinImport:off
import * as NodeTimersPromises from "node:timers/promises";

/**
 * Settles with `work`, or with `expired` once `ms` pass first. The work is never cancelled;
 * the timer is, so a settled race does not hold the process open until the deadline.
 */
export const withinDeadline = async <A, B>(
  work: Promise<A>,
  ms: number,
  expired: B,
): Promise<A | B> => {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      work,
      NodeTimersPromises.setTimeout(ms, expired, { signal: deadline.signal }),
    ]);
  } finally {
    deadline.abort();
  }
};
