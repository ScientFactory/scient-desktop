import { describe, expect, it } from "vite-plus/test";

import { analyticsFailureCode } from "./ProviderFailureCodes.ts";

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
    ["codex", "auth-failed"],
    ["claudeAgent", "api_error_99"],
    ["scient", "http_999"],
    ["scient", "error_max_turns"],
    ["cursor", "usageLimitExceeded"],
    ["scient", null],
  ])("drops %s's code %s", (provider, code) => {
    expect(analyticsFailureCode(provider, code)).toBeUndefined();
  });
});
