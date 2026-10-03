/**
 * Oh My Pi reports a model failure as turn data, not as an RPC error. The
 * assistant message ends with `stopReason` `"error"` or `"aborted"` and an
 * `errorMessage`; a session retry that gives up ends with
 * `auto_retry_end{success:false, finalError}`; and OMP 18.3+ closes every
 * prompt with `prompt_result{status}`. This module turns what the runtime saw
 * into the single terminal outcome Scient reports for the turn.
 */
import type { OmpTarget } from "./OmpTarget.ts";

/** Longest `errorMessage` reported on a failed turn. */
export const OMP_ERROR_MESSAGE_MAX_CHARS = 512;

const failedFallback = (target: OmpTarget) => `${target.name} failed this turn.`;
const abortedFallback = (target: OmpTarget) => `${target.name} aborted this turn.`;

/** What the runtime observed about one turn when it settled. */
export interface OmpTurnEvidence {
  /**
   * `terminal`: a terminal agent_end followed by an idle confirmation.
   * `unconfirmed`: the drain was never confirmed, or the process exited.
   */
  readonly settlement: "terminal" | "unconfirmed";
  /** `prompt_result.status` for this turn's prompt (OMP 18.3+). */
  readonly promptStatus?: string | undefined;
  /** `prompt_result.error.message`. */
  readonly promptError?: string | undefined;
  /** The last assistant `message_end` of this turn. */
  readonly stopReason?: string | undefined;
  readonly errorMessage?: string | undefined;
  /** `auto_retry_end{success:false}` arrived, and no later attempt started. */
  readonly retryExhausted?: boolean | undefined;
  readonly retryFinalError?: string | undefined;
}

export type OmpTurnVerdict =
  | {
      readonly outcome: "failed";
      readonly stopReason: "abort" | "error";
      readonly errorMessage: string;
    }
  | { readonly outcome: "completed"; readonly stopReason?: "length" }
  | { readonly outcome: "unknown" };

/** A non-empty error message of at most 512 characters. */
export const clipOmpErrorMessage = (
  target: OmpTarget,
  value: string | undefined,
  fallback = failedFallback(target),
) => {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.length > OMP_ERROR_MESSAGE_MAX_CHARS
    ? `${trimmed.slice(0, OMP_ERROR_MESSAGE_MAX_CHARS - 1)}…`
    : trimmed;
};

const promptCategory = (status: string | undefined) =>
  status === "completed" || status === "error" || status === "aborted" ? status : undefined;

const firstText = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value.trim().length > 0);

/**
 * The terminal outcome of a turn. The first matching rule wins:
 *
 * 1. no confirmed terminal (drain unconfirmed, process exit) → unknown
 * 2. aborted → failed, `stopReason: "abort"`. Scient's Stop closes the
 *    process instead of aborting, so an abort always came from elsewhere.
 * 3. a model error → failed, `stopReason: "error"`, detail from the retry's
 *    final error, then the message's error, then the prompt result's
 * 4. a session retry gave up → failed, as above
 * 5. `stopReason: "length"` → completed, keeping the stop reason
 * 6. otherwise (stop, toolUse, a recovered retry) → completed
 *
 * `prompt_result.status` is authoritative for rules 2–4 when present; the
 * assistant message and retry frames supply the detail, and decide alone on
 * OMP releases without a prompt status.
 */
export const classifyOmpTurnOutcome = (
  target: OmpTarget,
  evidence: OmpTurnEvidence,
): OmpTurnVerdict => {
  if (evidence.settlement === "unconfirmed") return { outcome: "unknown" };
  const category =
    promptCategory(evidence.promptStatus) ??
    (evidence.stopReason === "aborted"
      ? "aborted"
      : evidence.stopReason === "error" || evidence.retryExhausted === true
        ? "error"
        : "completed");
  if (category === "aborted") {
    return {
      outcome: "failed",
      stopReason: "abort",
      errorMessage: clipOmpErrorMessage(
        target,
        firstText(evidence.errorMessage, evidence.promptError),
        abortedFallback(target),
      ),
    };
  }
  if (category === "error") {
    return {
      outcome: "failed",
      stopReason: "error",
      errorMessage: clipOmpErrorMessage(
        target,
        firstText(evidence.retryFinalError, evidence.errorMessage, evidence.promptError),
      ),
    };
  }
  return evidence.stopReason === "length"
    ? { outcome: "completed", stopReason: "length" }
    : { outcome: "completed" };
};
