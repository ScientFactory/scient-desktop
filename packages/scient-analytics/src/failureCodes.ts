/**
 * Which provider failure codes may leave the computer as `failureCode`. Some adapters pass through
 * a provider's free string, and looking like an identifier does not make it a category, so each
 * provider's known codes are listed and anything else is dropped, never truncated or hashed.
 * The contract applies this list itself, so no caller can widen it.
 */

/** Codes the host itself sets, whatever the provider. */
const HOST_CODES = new Set(["oom_kill", "retry_stalled", "prompt_inactivity"]);

/** Scient Agent and Oh My Pi: the agent's error kinds and the OMP host's outcome reasons. */
const OMP_CODES = new Set([
  "cost_cap",
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
  "network",
  "silent-abort",
  "user-interrupt",
  "abort",
  "transient",
  "process_exit",
  "prompt_result_timeout",
  "drain_busy",
  "idle_confirmation_failed",
  "unconfirmed",
  "command_rejected",
  // No cause from the agent: where the failure's evidence came from.
  "unrecognized_error_kind",
  "prompt_result_error",
  "retry_exhausted",
  "assistant_error",
  "prompt_command_failed",
  "command_timeout",
  "rpc_failed",
]);

/** Claude Agent SDK result subtypes, process exits, and Scient's own Claude codes. */
const CLAUDE_CODES = new Set([
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
  "process_killed_by_signal",
  "process_exited_nonzero",
  "claude_mod_ui_unsupported",
  "compaction_failed",
]);

/** Codex app-server error variants. */
const CODEX_CODES = new Set([
  "contextWindowExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "serverOverloaded",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "sandboxError",
  "threadRollbackFailed",
  "other",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
  // ChatGPT sharing's own reasons, which Codex relays and `CodexManagedErrors` curates.
  "subscription_sharing_v2_user_not_eligible",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_v2_client_not_enabled",
  "subscription_sharing_v2_route_not_supported",
  "subscription_sharing_v2_invalid_user",
  "subscription_sharing_v2_user_unavailable",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "subscription_sharing_user_unavailable",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]);

/** Antigravity: Google's RPC status names, and Scient's harness error categories. */
const ANTIGRAVITY_CODES = new Set([
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
  "QUOTA_EXHAUSTED",
  "mcp_load_failed",
  "harness_error",
]);

/** Droid's turn-end reasons, and Factory's missing-subscription code. */
const DROID_CODES = new Set([
  "model_usage_exhausted",
  "model_rate_limited",
  "model_authentication_failed",
  "model_provider_unreachable",
  "model_provider_unavailable",
  "model_request_rejected",
  "prompt_rejected",
  "no_approver_available",
  "host_resources_exhausted",
  "completion_persistence_failed",
  "structured_output_missing",
  "structured_output_invalid",
  "structured_output_schema_invalid",
  "process_exit",
  "error",
  "no_active_subscription",
]);

const HTTP_CODE = /^http_[1-5]\d\d$/u;
const CLAUDE_API_ERROR_CODE = /^api_error_[1-5]\d\d$/u;

/**
 * The class to report for a failure whose validated code names it more exactly. Scient Agent can
 * end a turn on a usage-limit kind without the cost cap or HTTP 429 its classifier keys on, so
 * that turn says provider_error while its code says usage-limit. Only the report changes: the
 * classifier also drives recovery, which keeps its own class.
 */
export function analyticsFailureClass(
  provider: string,
  failureClass: string,
  failureCode: string | undefined,
): string {
  return (provider === "scient" || provider === "omp") &&
    failureClass === "provider_error" &&
    failureCode === "usage-limit"
    ? "usage_limit"
    : failureClass;
}

/** The code to report for a failure of `provider`, or undefined when it is not a known category. */
export function analyticsFailureCode(provider: string, code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  if (HOST_CODES.has(code)) return code;
  switch (provider) {
    case "scient":
    case "omp":
      return OMP_CODES.has(code) || HTTP_CODE.test(code) ? code : undefined;
    case "claudeAgent":
      return CLAUDE_CODES.has(code) || CLAUDE_API_ERROR_CODE.test(code) ? code : undefined;
    case "codex":
      return CODEX_CODES.has(code) ? code : undefined;
    case "antigravity":
      return ANTIGRAVITY_CODES.has(code) ? code : undefined;
    case "droid":
      return DROID_CODES.has(code) ? code : undefined;
    default:
      return undefined;
  }
}
