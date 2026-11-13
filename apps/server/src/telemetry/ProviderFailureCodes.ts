/**
 * Which provider failure codes may leave the computer as `failureCode`. Some adapters pass through
 * a provider's free string, and looking like an identifier does not make it a category, so each
 * provider's known codes are listed and anything else is dropped, never truncated or hashed.
 */

/** Codes the host itself sets, whatever the provider. */
const HOST_CODES = new Set(["oom_kill", "retry_stalled"]);

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
]);

const HTTP_CODE = /^http_[1-5]\d\d$/u;
const CLAUDE_API_ERROR_CODE = /^api_error_[1-5]\d\d$/u;
/** ChatGPT sharing's own reasons, which Codex relays and `CodexManagedErrors` curates. */
const CODEX_SHARING_CODE = /^(?:subscription_sharing|chatpass)_[a-z0-9_]{1,48}$/u;

/** The code to report for a failure of `provider`, or undefined when it is not a known category. */
export function analyticsFailureCode(provider: string, code: string | null): string | undefined {
  if (code === null) return undefined;
  if (HOST_CODES.has(code)) return code;
  switch (provider) {
    case "scient":
    case "omp":
      return OMP_CODES.has(code) || HTTP_CODE.test(code) ? code : undefined;
    case "claudeAgent":
      return CLAUDE_CODES.has(code) || CLAUDE_API_ERROR_CODE.test(code) ? code : undefined;
    case "codex":
      return CODEX_CODES.has(code) || CODEX_SHARING_CODE.test(code) ? code : undefined;
    default:
      return undefined;
  }
}
