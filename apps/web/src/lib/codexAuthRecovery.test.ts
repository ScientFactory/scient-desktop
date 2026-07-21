import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { findCodexAuthenticationRecoveryActivityId } from "./codexAuthRecovery";

const authenticationActivity = {
  id: EventId.makeUnsafe("auth-activity"),
  createdAt: "2026-07-21T10:00:00.000Z",
  tone: "error",
  kind: "runtime.error",
  summary: "Provider runtime error",
  payload: { message: "Authentication required", class: "authentication_error" },
  turnId: null,
} satisfies OrchestrationThreadActivity;

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
        activities: [authenticationActivity],
        providerStatus: standardCodexStatus,
      }),
    ).toBe("auth-activity");
  });

  it("does not reopen recovery after the thread session has recovered", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "ready",
        activities: [authenticationActivity],
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
  });

  it("never routes a custom Codex provider into ChatGPT sign-in", () => {
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        activities: [authenticationActivity],
        providerStatus: { ...standardCodexStatus, requiresProviderAccount: false },
      }),
    ).toBeNull();
  });

  it("ignores generic runtime errors and non-Codex providers", () => {
    const genericError = {
      ...authenticationActivity,
      id: EventId.makeUnsafe("generic-error"),
      payload: { message: "Provider failed", class: "provider_error" },
    } satisfies OrchestrationThreadActivity;

    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        activities: [genericError],
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "claudeAgent",
        sessionStatus: "error",
        activities: [authenticationActivity],
        providerStatus: { ...standardCodexStatus, provider: "claudeAgent" },
      }),
    ).toBeNull();
  });

  it("does not revive an old auth failure after a newer unrelated runtime error", () => {
    const newerGenericError = {
      ...authenticationActivity,
      id: EventId.makeUnsafe("newer-generic-error"),
      createdAt: "2026-07-21T10:01:00.000Z",
      payload: { message: "Provider failed", class: "provider_error" },
    } satisfies OrchestrationThreadActivity;

    expect(
      findCodexAuthenticationRecoveryActivityId({
        provider: "codex",
        sessionStatus: "error",
        activities: [authenticationActivity, newerGenericError],
        providerStatus: standardCodexStatus,
      }),
    ).toBeNull();
  });
});
