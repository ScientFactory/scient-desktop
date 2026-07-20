import { describe, expect, it, vi } from "vitest";

import {
  probeClaudeAccountCapabilities,
  sanitizeClaudeAccountCapabilities,
  type ClaudeCapabilitiesQueryFactory,
} from "./claudeCapabilities";

describe("Claude account capability probing", () => {
  it("returns only non-secret account metadata from SDK initialization", async () => {
    let capturedOptions: Parameters<ClaudeCapabilitiesQueryFactory>[0]["options"] | undefined;
    const close = vi.fn();
    const createQuery: ClaudeCapabilitiesQueryFactory = (input) => {
      capturedOptions = input.options;
      return {
        initializationResult: async () => ({
          account: {
            email: "scientist@example.test",
            organization: "Research Lab",
            subscriptionType: "max",
            tokenSource: "claude.ai",
            apiProvider: "firstParty",
            accessToken: "must-not-escape",
          },
        }),
        close,
      };
    };

    await expect(
      probeClaudeAccountCapabilities({
        executable: "/custom/claude",
        env: { HOME: "/Users/tester" },
        cwd: "/workspace",
        createQuery,
      }),
    ).resolves.toEqual({
      email: "scientist@example.test",
      organization: "Research Lab",
      subscriptionType: "max",
      tokenSource: "claude.ai",
      apiProvider: "firstParty",
    });
    expect(capturedOptions).toMatchObject({
      pathToClaudeCodeExecutable: "/custom/claude",
      persistSession: false,
      allowedTools: [],
      cwd: "/workspace",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not treat an empty initialization account as authentication proof", async () => {
    const createQuery: ClaudeCapabilitiesQueryFactory = () => ({
      initializationResult: async () => ({ account: {} }),
      close: () => undefined,
    });

    await expect(
      probeClaudeAccountCapabilities({ executable: "claude", env: {}, createQuery }),
    ).resolves.toBeUndefined();
  });

  it("times out and closes a stalled SDK probe", async () => {
    const close = vi.fn();
    const createQuery: ClaudeCapabilitiesQueryFactory = () => ({
      initializationResult: () => new Promise(() => undefined),
      close,
    });

    await expect(
      probeClaudeAccountCapabilities({
        executable: "claude",
        env: {},
        timeoutMs: 1,
        createQuery,
      }),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects token-only objects during sanitization", () => {
    expect(sanitizeClaudeAccountCapabilities({ accessToken: "secret" })).toBeUndefined();
  });

  it("does not treat Claude's logged-out sentinel values as authentication proof", () => {
    expect(
      sanitizeClaudeAccountCapabilities({
        tokenSource: "none",
        apiKeySource: "not_configured",
        subscriptionType: "unknown",
        apiProvider: "firstParty",
      }),
    ).toBeUndefined();
  });

  it("does not treat a first-party backend selection alone as a logged-in account", () => {
    expect(sanitizeClaudeAccountCapabilities({ apiProvider: "firstParty" })).toBeUndefined();
    expect(sanitizeClaudeAccountCapabilities({ apiProvider: "bedrock" })).toEqual({
      apiProvider: "bedrock",
    });
  });
});
