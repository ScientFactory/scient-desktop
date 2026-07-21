import { describe, expect, it } from "vitest";

import { findCodexAuthenticationRecoveryActivityId } from "./codexAuthRecovery";

const authenticationEventId = "auth-event";

const standardCodexStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  requiresProviderAccount: true,
  checkedAt: "2026-07-21T10:00:00.000Z",
} as const;

describe("findCodexAuthenticationRecoveryActivityId", () => {
  it("offers recovery for the latest classified Codex auth failure", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: authenticationEventId,
        sessionLastErrorClass: "authentication_error",
        providerStatus: standardCodexStatus,
      }),
    ).toBe(authenticationEventId);
  });

  it("does not reopen recovery after the thread session has recovered", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "ready",
        sessionLastErrorEventId: authenticationEventId,
        sessionLastErrorClass: "authentication_error",
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
  });

  it("requires both durable error identity and the persisted authentication class", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: null,
        sessionLastErrorClass: "authentication_error",
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: authenticationEventId,
        sessionLastErrorClass: null,
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
  });

  it("never routes a custom Codex provider into ChatGPT sign-in", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: authenticationEventId,
        sessionLastErrorClass: "authentication_error",
        providerStatus: { ...standardCodexStatus, requiresProviderAccount: false },
      }),
    ).toBeNull();
  });

  it("ignores generic runtime errors and non-Codex providers", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: "generic-error",
        sessionLastErrorClass: "provider_error",
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "claudeAgent",
        sessionStatus: "error",
        sessionLastErrorEventId: authenticationEventId,
        sessionLastErrorClass: "authentication_error",
        providerStatus: { ...standardCodexStatus, provider: "claudeAgent" },
      }),
    ).toBeNull();
  });

  it("does not revive an old auth failure after a newer unrelated runtime error", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: "newer-generic-error",
        sessionLastErrorClass: "provider_error",
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
  });

  it("does not reopen an old auth failure after a later failed turn", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        sessionLastErrorEventId: "later-failed-turn",
        sessionLastErrorClass: null,
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
  });
});
