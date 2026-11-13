import { describe, expect, it } from "@effect/vitest";

import { analyticsFailureCode } from "./failureCodes.ts";

describe("analyticsFailureCode", () => {
  it.each([
    ["scient", "auth-failed"],
    ["omp", "http_503"],
    ["scient", "process_exit"],
    ["claudeAgent", "error_max_turns"],
    ["claudeAgent", "api_error_529"],
    ["codex", "contextWindowExceeded"],
    ["codex", "subscription_sharing_usage_limit_exceeded"],
    ["cursor", "oom_kill"],
    ["codex", "retry_stalled"],
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
    ["scient", "http_999"],
    ["scient", "error_max_turns"],
    ["cursor", "usageLimitExceeded"],
    ["scient", null],
  ])("drops %s's code %s", (provider, code: unknown) => {
    expect(analyticsFailureCode(provider, code)).toBeUndefined();
  });
});
