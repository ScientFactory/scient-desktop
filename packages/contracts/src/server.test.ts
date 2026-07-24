import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ServerProviderConnectionCancelInput,
  ServerProviderConnectionStartInput,
  ServerProviderConnectionSubmitAuthorizationCodeInput,
  ServerProviderInstallInput,
  ServerProviderStatus,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "./server";

describe("provider connection contracts", () => {
  it("decodes supported provider sign-in requests", () => {
    const decode = Schema.decodeUnknownSync(ServerProviderConnectionStartInput);
    expect(decode({ provider: "codex", method: "codex_browser" })).toEqual({
      provider: "codex",
      method: "codex_browser",
    });
    expect(decode({ provider: "codex", method: "codex_device_code" })).toEqual({
      provider: "codex",
      method: "codex_device_code",
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

  it("decodes an explicit install-to-sign-in handoff", () => {
    expect(
      Schema.decodeUnknownSync(ServerProviderInstallInput)({
        provider: "codex",
        planToken: "plan-1",
        connectionMethod: "codex_browser",
      }),
    ).toEqual({
      provider: "codex",
      planToken: "plan-1",
      connectionMethod: "codex_browser",
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

  it("accepts a bounded one-time authorization code and rejects control characters", () => {
    const decode = Schema.decodeUnknownSync(ServerProviderConnectionSubmitAuthorizationCodeInput);
    expect(
      decode({
        provider: "antigravity",
        operationId: "operation-1",
        authorizationCode: "  4/test_code-123  ",
      }),
    ).toEqual({
      provider: "antigravity",
      operationId: "operation-1",
      authorizationCode: "4/test_code-123",
    });
    const rejectedCode = "4/test-code\nsecond-line";
    let diagnostic = "";
    try {
      decode({
        provider: "antigravity",
        operationId: "operation-1",
        authorizationCode: rejectedCode,
      });
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).not.toBe("");
    expect(diagnostic).not.toContain(rejectedCode);
    expect(diagnostic).not.toContain("test-code");
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
        userCode: "ABCD-EFGH",
      },
    });

    expect(decoded.connectionState?.status).toBe("waiting_for_browser");
    expect(decoded.connectionState?.authorizationUrl).toContain("https://auth.x.ai/");
    expect(decoded.connectionState?.userCode).toBe("ABCD-EFGH");
    expect(Object.keys(decoded.connectionState ?? {})).not.toContain("token");
    expect(Object.keys(decoded.connectionState ?? {})).not.toContain("output");
  });
});

describe("voice transcription contracts", () => {
  it("accepts provider-neutral desktop requests and routed metadata", () => {
    const request = Schema.decodeUnknownSync(ServerVoiceTranscriptionInput)({
      cwd: "/workspace",
      mode: "offline-only",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1,
      audioBase64: "AAAA",
    });
    expect(request.provider).toBeUndefined();
    expect(request.mode).toBe("offline-only");

    expect(
      Schema.decodeUnknownSync(ServerVoiceTranscriptionResult)({
        text: "hello",
        engine: "local",
        fallbackUsed: true,
        fallbackReason: "network",
      }),
    ).toMatchObject({ engine: "local", fallbackUsed: true });
  });
});
