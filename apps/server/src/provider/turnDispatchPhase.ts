/**
 * Compatibility delivery-certainty classifier retained by the handoff tests.
 *
 * Callers mark failures raised after dispatch as potentially delivered.
 * Classification is by phase, not by error class; interrupts and defects remain
 * conservative. Current V2 handoff policy owns production delivery certainty.
 */
import * as Cause from "effect/Cause";

export type TurnDispatchDelivery = "notSent" | "maybeDelivered";

const dispatchAttemptedFailures = new WeakSet<object>();

export function markTurnDispatchAttempted(error: unknown): void {
  if (typeof error === "object" && error !== null) dispatchAttemptedFailures.add(error);
}

/**
 * Only typed failures never marked as dispatched count as `notSent`;
 * interrupts, defects and failures marked after dispatch are `maybeDelivered`.
 */
export function classifyTurnDispatchFailure(cause: Cause.Cause<unknown>): TurnDispatchDelivery {
  if (cause.reasons.length === 0) return "maybeDelivered";
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) return "maybeDelivered";
    const error = reason.error;
    if (typeof error !== "object" || error === null) return "maybeDelivered";
    if (dispatchAttemptedFailures.has(error)) return "maybeDelivered";
  }
  return "notSent";
}
