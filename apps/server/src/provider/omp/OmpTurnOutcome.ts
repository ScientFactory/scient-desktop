/**
 * Oh My Pi reports a model failure as turn data, not as an RPC error. The
 * assistant message ends with `stopReason` `"error"` or `"aborted"` and an
 * `errorMessage`; a session retry that gives up ends with
 * `auto_retry_end{success:false, finalError}`; and OMP 18.3+ closes every
 * prompt with `prompt_result{status}`. This module turns what the runtime saw
 * into the single terminal outcome Scient reports for the turn.
 */

/** Longest `errorMessage` reported on a failed turn. */
export const OMP_ERROR_MESSAGE_MAX_CHARS = 512;

const FAILED_FALLBACK = "Oh My Pi failed this turn.";
const ABORTED_FALLBACK = "Oh My Pi aborted this turn.";

/** What the runtime observed about one turn when it settled. */
export interface OmpTurnEvidence {
  /**
   * `terminal`: a terminal agent_end followed by an idle confirmation.
   * `cancel-confirmed`: OMP acknowledged the user's abort.
   * `unconfirmed`: the drain was never confirmed, or the process exited.
   */
  readonly settlement: "terminal" | "cancel-confirmed" | "unconfirmed";
  readonly cancelRequested: boolean;
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
  | { readonly outcome: "interrupted" }
  | {
      readonly outcome: "failed";
      readonly stopReason: "abort" | "error";
      readonly errorMessage: string;
    }
  | { readonly outcome: "completed"; readonly stopReason?: "length" }
  | { readonly outcome: "unknown" };

/** A non-empty error message of at most 512 characters. */
export const clipOmpErrorMessage = (value: string | undefined, fallback = FAILED_FALLBACK) => {
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
 * 2. the user requested cancellation → interrupted
 * 3. aborted without a user cancel → failed, `stopReason: "abort"`
 * 4. a model error → failed, `stopReason: "error"`, detail from the retry's
 *    final error, then the message's error, then the prompt result's
 * 5. a session retry gave up → failed, as above
 * 6. `stopReason: "length"` → completed, keeping the stop reason
 * 7. otherwise (stop, toolUse, a recovered retry) → completed
 *
 * `prompt_result.status` is authoritative for rules 3–5 when present; the
 * assistant message and retry frames supply the detail, and decide alone on
 * OMP releases without a prompt status.
 */
export const classifyOmpTurnOutcome = (evidence: OmpTurnEvidence): OmpTurnVerdict => {
  if (evidence.settlement === "unconfirmed") return { outcome: "unknown" };
  if (evidence.cancelRequested) return { outcome: "interrupted" };
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
        firstText(evidence.errorMessage, evidence.promptError),
        ABORTED_FALLBACK,
      ),
    };
  }
  if (category === "error") {
    return {
      outcome: "failed",
      stopReason: "error",
      errorMessage: clipOmpErrorMessage(
        firstText(evidence.retryFinalError, evidence.errorMessage, evidence.promptError),
      ),
    };
  }
  return evidence.stopReason === "length"
    ? { outcome: "completed", stopReason: "length" }
    : { outcome: "completed" };
};
