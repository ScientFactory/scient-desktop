/**
 * OMP reports model failures in turn data, not RPC errors. Combine assistant stop/error, exhausted
 * retry, and prompt_result evidence into one terminal outcome.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

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
  /** `prompt_result.error.code`. */
  readonly promptErrorCode?: string | undefined;
  /** `prompt_result.error.httpStatus`. */
  readonly promptHttpStatus?: number | undefined;
  /** `prompt_result.error.resetAt`, epoch ms. */
  readonly promptResetAt?: number | undefined;
  /** `prompt_result.error.kinds`: the agent's error classifier labels. */
  readonly promptErrorKinds?: ReadonlyArray<string> | undefined;
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
      readonly failureClass?: "usage_limit";
      /** ISO time at which the provider said the usage limit resets. */
      readonly resetAt?: string;
      /** Why the provider failed the turn: see {@link ompFailureCode}. */
      readonly failureCode?: string;
      /** The provider's HTTP status, when the failure came from a request. */
      readonly httpStatus?: number;
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

const isoTime = (epochMs: number | undefined) =>
  epochMs === undefined
    ? Option.none()
    : DateTime.make(epochMs).pipe(Option.map(DateTime.formatIso));

/**
 * The agent's error kinds, most specific cause first. A failure usually carries one kind; when it
 * carries several (a usage limit is also transient), the earliest here names it. Kinds this list
 * does not know are ignored.
 */
const OMP_FAILURE_KIND_PRIORITY = [
  "oauth-expiry",
  "usage-limit",
  "account-policy",
  "auth-failed",
  "content-blocked",
  "payload-rejected",
  "context-overflow",
  "grammar",
  "fast-mode-unsupported",
  "cache-control-unsupported",
  "malformed-function-call",
  "stale-responses-item",
  "thinking-loop",
  "empty-response",
  "provider-finish-error",
  "timeout",
  "silent-abort",
  "user-interrupt",
  "abort",
  "transient",
] as const;

const httpStatus = (value: number | undefined) =>
  value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

/**
 * One code for why the provider failed a turn: `cost_cap`, then the agent's most specific error
 * kind, then `http_<status>`. Agents before error kinds report only the status.
 */
const ompFailureCode = (evidence: OmpTurnEvidence): string | undefined => {
  if (evidence.promptErrorCode === "cost_cap") return "cost_cap";
  const kinds = new Set(evidence.promptErrorKinds);
  const kind = OMP_FAILURE_KIND_PRIORITY.find((candidate) => kinds.has(candidate));
  if (kind !== undefined) return kind;
  const status = httpStatus(evidence.promptHttpStatus);
  return status === undefined ? undefined : `http_${status}`;
};

const firstText = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value.trim().length > 0);

/**
 * Without confirmed terminal evidence, report unknown. A confirmed abort is failed; the Stop owner
 * maps user-requested aborts to interruption. prompt_result status is authoritative when present;
 * older versions use assistant/retry frames. Preserve length as completed and prefer retry error detail.
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
  const failureCode = ompFailureCode(evidence);
  const status = httpStatus(evidence.promptHttpStatus);
  const cause = {
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(status === undefined ? {} : { httpStatus: status }),
  };
  if (category === "aborted") {
    return {
      outcome: "failed",
      stopReason: "abort",
      errorMessage: clipOmpErrorMessage(
        target,
        firstText(evidence.errorMessage, evidence.promptError),
        abortedFallback(target),
      ),
      ...cause,
    };
  }
  if (category === "error") {
    // A spending cap or a provider's 429 needs the user, not another attempt.
    const usageLimit = evidence.promptErrorCode === "cost_cap" || evidence.promptHttpStatus === 429;
    const resetAt = usageLimit ? isoTime(evidence.promptResetAt) : Option.none();
    return {
      outcome: "failed",
      stopReason: "error",
      errorMessage: clipOmpErrorMessage(
        target,
        firstText(evidence.retryFinalError, evidence.errorMessage, evidence.promptError),
      ),
      ...(usageLimit ? { failureClass: "usage_limit" as const } : {}),
      ...(Option.isSome(resetAt) ? { resetAt: resetAt.value } : {}),
      ...cause,
    };
  }
  return evidence.stopReason === "length"
    ? { outcome: "completed", stopReason: "length" }
    : { outcome: "completed" };
};
