import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  INITIAL_ONBOARDING_STORAGE,
  decideOnboardingVisibility,
  onboardingProviderState,
} from "./onboarding.logic";

const checkedAt = "2026-07-22T10:00:00.000Z";

function status(overrides: Partial<ServerProviderStatus>): ServerProviderStatus {
  return {
    provider: "codex",
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt,
    ...overrides,
  };
}

describe("decideOnboardingVisibility", () => {
  it("never shows before the first provider snapshot", () => {
    expect(
      decideOnboardingVisibility({ storage: INITIAL_ONBOARDING_STORAGE, providers: undefined }),
    ).toBe("hide");
    expect(decideOnboardingVisibility({ storage: INITIAL_ONBOARDING_STORAGE, providers: [] })).toBe(
      "hide",
    );
  });

  it("shows for a fresh install with no connected featured provider", () => {
    expect(
      decideOnboardingVisibility({
        storage: INITIAL_ONBOARDING_STORAGE,
        providers: [status({ provider: "codex", available: true, authStatus: "unauthenticated" })],
      }),
    ).toBe("show");
  });

  it("completes silently when a featured provider is already connected", () => {
    expect(
      decideOnboardingVisibility({
        storage: INITIAL_ONBOARDING_STORAGE,
        providers: [
          status({
            provider: "claudeAgent",
            status: "ready",
            available: true,
            authStatus: "authenticated",
          }),
        ],
      }),
    ).toBe("complete");
  });

  it("ignores connected providers outside the featured set", () => {
    expect(
      decideOnboardingVisibility({
        storage: INITIAL_ONBOARDING_STORAGE,
        providers: [
          status({
            provider: "grok",
            status: "ready",
            available: true,
            authStatus: "authenticated",
          }),
          status({ provider: "codex", available: true, authStatus: "unauthenticated" }),
        ],
      }),
    ).toBe("show");
  });

  it("never reappears after dismissal or completion", () => {
    const providers = [
      status({ provider: "codex", available: true, authStatus: "unauthenticated" }),
    ];
    expect(
      decideOnboardingVisibility({
        storage: { completedAt: null, dismissed: true },
        providers,
      }),
    ).toBe("hide");
    expect(
      decideOnboardingVisibility({
        storage: { completedAt: checkedAt, dismissed: false },
        providers,
      }),
    ).toBe("hide");
  });
});

describe("onboardingProviderState", () => {
  it("maps missing or unprobed statuses to checking", () => {
    expect(onboardingProviderState(undefined)).toBe("checking");
    expect(onboardingProviderState(status({}))).toBe("checking");
  });

  it("maps connected and unauthenticated states", () => {
    expect(
      onboardingProviderState(
        status({ status: "ready", available: true, authStatus: "authenticated" }),
      ),
    ).toBe("connected");
    expect(
      onboardingProviderState(status({ available: true, authStatus: "unauthenticated" })),
    ).toBe("not_connected");
    expect(
      onboardingProviderState(
        status({
          available: false,
          runtime: {
            source: "missing",
            managedVersion: null,
            canInstall: true,
            canRepair: false,
            canRollback: false,
            canRemove: false,
            message: null,
          },
        }),
      ),
    ).toBe("not_connected");
  });

  it("marks live sign-ins and installs as pending", () => {
    expect(
      onboardingProviderState(
        status({
          available: true,
          authStatus: "unauthenticated",
          connectionState: {
            operationId: "operation-1",
            method: "codex_browser",
            status: "waiting_for_browser",
            startedAt: checkedAt,
            finishedAt: null,
            message: "Waiting.",
          },
        }),
      ),
    ).toBe("sign_in_pending");
    expect(
      onboardingProviderState(
        status({
          installationState: {
            operationId: "operation-2",
            operation: "install",
            status: "downloading",
            startedAt: checkedAt,
            finishedAt: null,
            message: "Downloading.",
          },
        }),
      ),
    ).toBe("sign_in_pending");
  });
});
