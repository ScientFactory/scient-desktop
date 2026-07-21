// FILE: claudeProcessEnv.test.ts
// Purpose: Covers Claude env sanitization for supported third-party authentication.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeProcessEnv.ts.
import { describe, it, assert } from "@effect/vitest";

import { buildClaudeProcessEnv } from "./claudeProcessEnv.ts";

describe("claudeProcessEnv", () => {
  it("preserves every Claude-supported credential source", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "console-api-key",
      ANTHROPIC_AUTH_TOKEN: "console-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    };

    const result = buildClaudeProcessEnv({ env });

    assert.equal(result.PATH, "/bin");
    assert.equal(result.HOME, "/home/tester");
    assert.equal(result.ANTHROPIC_API_KEY, "console-api-key");
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, "console-auth-token");
    assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "subscription-token");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "subscription-token");
  });

  it("aligns subprocess HOME with the configured credential home", () => {
    const result = buildClaudeProcessEnv({
      env: { HOME: "/wrong-home" },
      homeDir: "/home/tester",
    });

    assert.equal(result.HOME, "/home/tester");
  });

  it("preserves explicitly configured Claude-compatible backends", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "proxy-api-key",
        ANTHROPIC_BASE_URL: "https://anthropic-proxy.example.test",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
    });

    assert.equal(result.ANTHROPIC_API_KEY, "proxy-api-key");
    assert.equal(result.ANTHROPIC_BASE_URL, "https://anthropic-proxy.example.test");
    assert.equal(result.CLAUDE_CODE_USE_BEDROCK, "1");
  });
});
