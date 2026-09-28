/**
 * Whether a failed provider turn could have reached the provider.
 *
 * SCIENT-OWNED. `ProviderService.sendTurn` marks every failure raised after it
 * handed the turn to an adapter. Everything before that point (schema checks,
 * input limits, session routing, skill preparation) provably sent nothing, so a
 * caller may retry it without risking a duplicate delivery.
 *
 * Classification is by phase, not by error class: the same class is raised on
 * both sides of the boundary (`ProviderValidationError` also comes from the
 * session directory after the provider accepted the turn). The vocabulary
 * mirrors upstream Orchestration V2's context-handoff delivery certainty.
 */
import * as Cause from "effect/Cause";

export type TurnDispatchDelivery = "notSent" | "maybeDelivered";

const dispatchAttemptedFailures = new WeakSet<object>();

export function markTurnDispatchAttempted(error: unknown): void {
  if (typeof error === "object" && error !== null) dispatchAttemptedFailures.add(error);
}

/**
 * Classifies a failure of `ProviderService.sendTurn`. Only typed failures that
 * were never handed to an adapter count as `notSent`; interrupts, defects and
 * anything raised at or after dispatch are `maybeDelivered`.
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
