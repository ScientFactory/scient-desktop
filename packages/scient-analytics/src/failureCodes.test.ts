import { describe, expect, it } from "@effect/vitest";

import { analyticsFailureClass, analyticsFailureCode } from "./failureCodes.ts";

describe("analyticsFailureCode", () => {
  it.each([
    ["scient", "auth-failed"],
    ["omp", "http_503"],
    ["scient", "process_exit"],
    ["claudeAgent", "error_max_turns"],
    ["claudeAgent", "api_error_529"],
    ["claudeAgent", "turn_setup_failed"],
    ["claudeAgent", "sdk_result_error"],
    ["claudeAgent", "assistant_model_not_found"],
    ["claudeAgent", "claude_stream_ended"],
    ["codex", "contextWindowExceeded"],
    ["codex", "subscription_sharing_usage_limit_exceeded"],
    ["cursor", "oom_kill"],
    ["codex", "retry_stalled"],
    ["antigravity", "prompt_inactivity"],
    ["antigravity", "mcp_load_failed"],
    ["droid", "model_usage_exhausted"],
  ])("keeps %s's known code %s", (provider, code) => {
    expect(analyticsFailureCode(provider, code)).toBe(code);
  });

  it.each([
    // Identifier-shaped values a provider could send as free strings.
    ["codex", "acme_private_project_x"],
    ["codex", "chatpass_private_prompt_fragment"],
    ["codex", "subscription_sharing_private_prompt_fragment"],
    ["scient", "private_prompt_fragment"],
    ["scient", 503],
    ["codex", "auth-failed"],
    ["claudeAgent", "api_error_99"],
    ["claudeAgent", "assistant_unknown"],
    ["claudeAgent", "completed"],
    ["scient", "http_999"],
    ["scient", "error_max_turns"],
    ["cursor", "usageLimitExceeded"],
    // A tool server's name is not a category.
    ["antigravity", "ct-crash"],
    ["droid", "UNAVAILABLE"],
    ["scient", null],
  ])("drops %s's code %s", (provider, code: unknown) => {
    expect(analyticsFailureCode(provider, code)).toBeUndefined();
  });
});

describe("analyticsFailureClass", () => {
  it("reports a Scient Agent usage-limit code as a usage limit, and nothing else changes", () => {
    expect(analyticsFailureClass("scient", "provider_error", "usage-limit")).toBe("usage_limit");
    expect(analyticsFailureClass("omp", "provider_error", "usage-limit")).toBe("usage_limit");
    expect(analyticsFailureClass("scient", "provider_error", "auth-failed")).toBe("provider_error");
    expect(analyticsFailureClass("scient", "provider_error", undefined)).toBe("provider_error");
    expect(analyticsFailureClass("scient", "aborted", "usage-limit")).toBe("aborted");
    // Claude's failed compaction under a rate limit keeps its pair: queued work waits on it.
    expect(analyticsFailureClass("claudeAgent", "usage_limit", "compaction_failed")).toBe(
      "usage_limit",
    );
    expect(analyticsFailureClass("codex", "provider_error", "usage-limit")).toBe("provider_error");
  });
});
