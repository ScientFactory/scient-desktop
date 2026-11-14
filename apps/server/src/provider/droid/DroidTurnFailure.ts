import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

interface TurnEndReason {
  readonly class: OrchestrationV2ProviderFailureClass;
  readonly retryable: boolean | null;
  readonly message: string;
}

/** Droid's own reasons for a turn that ended in an error (its ACP `data.reason`). */
const TURN_END_REASONS = {
  model_usage_exhausted: {
    class: "usage_limit",
    retryable: true,
    message: "Your Droid usage limit for this model is used up.",
  },
  model_rate_limited: {
    class: "usage_limit",
    retryable: true,
    message: "The model provider is rate limiting Droid. Try again shortly.",
  },
  model_authentication_failed: {
    class: "permission_error",
    retryable: false,
    message: "The model provider refused Droid's credentials or model access.",
  },
  model_provider_unreachable: {
    class: "transport_error",
    retryable: true,
    message: "Droid could not reach the model provider.",
  },
  model_provider_unavailable: {
    class: "provider_error",
    retryable: true,
    message: "The model provider was unavailable or timed out.",
  },
  model_request_rejected: {
    class: "validation_error",
    retryable: false,
    message: "The model provider rejected Droid's request.",
  },
  prompt_rejected: {
    class: "validation_error",
    retryable: false,
    message: "Droid refused this message: it is too large for the model or a hook blocked it.",
  },
  no_approver_available: {
    class: "provider_error",
    retryable: false,
    message: "Droid needed an answer to a tool call or question, and nobody could give it.",
  },
  host_resources_exhausted: {
    class: "provider_error",
    retryable: null,
    message: "This computer ran out of resources for Droid.",
  },
  completion_persistence_failed: {
    class: "provider_error",
    retryable: null,
    message: "Droid could not save the turn's result.",
  },
  structured_output_missing: {
    class: "provider_error",
    retryable: null,
    message: "Droid ended the turn without its structured output.",
  },
  structured_output_invalid: {
    class: "provider_error",
    retryable: null,
    message: "Droid's structured output did not match its schema.",
  },
  structured_output_schema_invalid: {
    class: "provider_error",
    retryable: false,
    message: "Droid rejected the structured output schema.",
  },
  process_exit: {
    class: "provider_error",
    retryable: null,
    message: "Droid's agent process exited during the turn.",
  },
  error: {
    class: "provider_error",
    retryable: null,
    message: "Droid's agent reported an error.",
  },
} as const satisfies Record<string, TurnEndReason>;

export type DroidTurnEndReason = keyof typeof TURN_END_REASONS;

const isTurnEndReason = (value: unknown): value is DroidTurnEndReason =>
  typeof value === "string" && Object.hasOwn(TURN_END_REASONS, value);

/** Only the fixed reason survives from Droid's error `data`, never its session id or text. */
export function droidTurnEndReason(data: unknown): DroidTurnEndReason | undefined {
  if (typeof data !== "object" || data === null || !("reason" in data)) return undefined;
  return isTurnEndReason(data.reason) ? data.reason : undefined;
}

/** Factory's JSON body after the status, e.g. `402 {"detail":"…","code":"no_active_subscription"}`. */
const FactoryErrorBody = Schema.fromJsonString(
  Schema.Struct({
    detail: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.String),
  }),
);
const decodeFactoryErrorBody = Schema.decodeUnknownOption(FactoryErrorBody);
const LEADING_STATUS = /^([45]\d\d)\s+(.*)$/su;
const PLACEHOLDER = /^Agent turn ended: [a-z_]+$/u;
const USAGE_LIMIT = /\busage limit\b/iu;
const RESETS_IN = /\bresets in (?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)\s*min)?/iu;
const NO_ACTIVE_SUBSCRIPTION = "no_active_subscription";

function resetAtFrom(text: string, now: DateTime.Utc): string | null {
  const match = RESETS_IN.exec(text);
  if (match === null) return null;
  const [, days = "0", hours = "0", minutes = "0"] = match;
  const delayMs = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000;
  return delayMs > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })) : null;
}

/**
 * Classifies a failed Droid prompt. Droid names the cause in `reason`; Factory's 402 body tells a
 * used-up plan from a missing subscription. `detail` is Droid's redacted text for the failure.
 */
export function droidTurnFailure(input: {
  readonly reason: DroidTurnEndReason | undefined;
  readonly detail: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderFailure {
  const { reason, detail, now } = input;
  const status = LEADING_STATUS.exec(detail);
  const httpStatus = status === null ? null : Number(status[1]);
  const body = status === null ? Option.none() : decodeFactoryErrorBody(status[2]);
  const bodyDetail = Option.isSome(body) ? body.value.detail?.trim() || undefined : undefined;
  const shown = bodyDetail ?? (detail && !PLACEHOLDER.test(detail) ? detail : undefined);
  if (Option.isSome(body) && body.value.code === NO_ACTIVE_SUBSCRIPTION) {
    return makeProviderFailure({
      class: "permission_error",
      message: shown ?? "Droid has no active subscription.",
      code: NO_ACTIVE_SUBSCRIPTION,
      retryable: false,
      httpStatus,
    });
  }
  const quota =
    reason === "model_usage_exhausted" ||
    (reason === undefined && httpStatus === 402 && USAGE_LIMIT.test(bodyDetail ?? ""));
  if (quota) {
    return makeProviderFailure({
      class: "usage_limit",
      message: shown ?? TURN_END_REASONS.model_usage_exhausted.message,
      code: "model_usage_exhausted",
      retryable: true,
      resetAt: resetAtFrom(shown ?? "", now),
      httpStatus,
    });
  }
  if (reason === undefined) {
    return makeProviderFailure({
      class: "provider_error",
      message: bodyDetail ?? (detail || undefined),
      httpStatus,
    });
  }
  const known = TURN_END_REASONS[reason];
  return makeProviderFailure({
    class: known.class,
    message: shown ?? known.message,
    code: reason,
    retryable: known.retryable,
    httpStatus,
  });
}
