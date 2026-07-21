import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ServerProviderConnectionCancelInput,
  ServerProviderConnectionStartInput,
  ServerProviderStatus,
} from "./server";

describe("provider connection contracts", () => {
  it("decodes supported provider sign-in requests", () => {
    const decode = Schema.decodeUnknownSync(ServerProviderConnectionStartInput);
    expect(decode({ provider: "codex", method: "codex_browser" })).toEqual({
      provider: "codex",
      method: "codex_browser",
    });
    expect(decode({ provider: "codex", method: "codex_browser", mode: "reauthenticate" })).toEqual({
      provider: "codex",
      method: "codex_browser",
      mode: "reauthenticate",
    });
    expect(decode({ provider: "claudeAgent", method: "claude_account" })).toEqual({
      provider: "claudeAgent",
      method: "claude_account",
    });
    expect(decode({ provider: "claudeAgent", method: "claude_sso" })).toEqual({
      provider: "claudeAgent",
      method: "claude_sso",
    });
    expect(decode({ provider: "claudeAgent", method: "claude_console" })).toEqual({
      provider: "claudeAgent",
      method: "claude_console",
    });
    expect(decode({ provider: "cursor", method: "cursor_browser" })).toEqual({
      provider: "cursor",
      method: "cursor_browser",
    });
  });

  it("rejects unknown connection methods and blank operation ids", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerProviderConnectionStartInput)({
        provider: "codex",
        method: "password",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServerProviderConnectionStartInput)({
        provider: "codex",
        method: "codex_browser",
        mode: "force",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServerProviderConnectionCancelInput)({
        provider: "codex",
        operationId: "   ",
      }),
    ).toThrow();
  });

  it("keeps connection progress optional for old provider snapshots", () => {
    const decoded = Schema.decodeUnknownSync(ServerProviderStatus)({
      provider: "codex",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt: "2026-07-19T10:00:00.000Z",
      message: "Sign in required.",
    });
    expect(decoded.connectionState).toBeUndefined();
  });

  it("decodes safe transient connection progress without credential fields", () => {
    const decoded = Schema.decodeUnknownSync(ServerProviderStatus)({
      provider: "codex",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt: "2026-07-19T10:00:00.000Z",
      connectionState: {
        operationId: "operation-1",
        method: "grok_browser",
        status: "waiting_for_browser",
        startedAt: "2026-07-19T10:00:00.000Z",
        finishedAt: null,
        message: "Finish signing in in the browser.",
        authorizationUrl:
          "https://auth.x.ai/oauth2/authorize?response_type=code&state=transient-test-state",
      },
    });

    expect(decoded.connectionState?.status).toBe("waiting_for_browser");
    expect(decoded.connectionState?.authorizationUrl).toContain("https://auth.x.ai/");
    expect(Object.keys(decoded.connectionState ?? {})).not.toContain("token");
    expect(Object.keys(decoded.connectionState ?? {})).not.toContain("output");
  });
});
