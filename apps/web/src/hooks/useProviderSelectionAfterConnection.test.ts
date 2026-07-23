import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  createProviderSelectionIntent,
  evaluateProviderSelectionIntent,
  resolvePostConnectionModel,
} from "./useProviderSelectionAfterConnection";

const REQUESTED_AT = Date.parse("2026-07-23T10:00:00.000Z");

function status(overrides: Partial<ServerProviderStatus> = {}): ServerProviderStatus {
  return {
    provider: "claudeAgent",
    status: "error",
    available: false,
    authStatus: "unauthenticated",
    checkedAt: "2026-07-23T09:59:00.000Z",
    ...overrides,
  };
}

function intent(initialStatus: ServerProviderStatus | null = status()) {
  return createProviderSelectionIntent({
    token: 1,
    scopeKey: "thread-1",
    provider: "claudeAgent",
    status: initialStatus,
    requestedAt: REQUESTED_AT,
  });
}

describe("provider selection after connection", () => {
  it("becomes ready only after the provider is verified usable", () => {
    expect(
      evaluateProviderSelectionIntent({
        intent: intent(),
        scopeKey: "thread-1",
        lockedProvider: null,
        status: status({
          status: "ready",
          available: true,
          authStatus: "authenticated",
          connectionState: {
            operationId: "connect-1",
            method: "claude_account",
            status: "connected",
            startedAt: "2026-07-23T10:00:01.000Z",
            finishedAt: "2026-07-23T10:00:02.000Z",
            message: "Connected.",
          },
        }),
      }),
    ).toEqual({ type: "ready", provider: "claudeAgent" });
  });

  it("survives an in-progress connection and clears when that operation fails", () => {
    const activeStatus = status({
      available: true,
      connectionState: {
        operationId: "connect-1",
        method: "claude_account",
        status: "waiting_for_browser",
        startedAt: "2026-07-23T10:00:01.000Z",
        finishedAt: null,
        message: "Finish signing in.",
      },
    });
    const active = evaluateProviderSelectionIntent({
      intent: intent(),
      scopeKey: "thread-1",
      lockedProvider: null,
      status: activeStatus,
    });
    expect(active.type).toBe("pending");
    if (active.type !== "pending") throw new Error("expected pending intent");

    expect(
      evaluateProviderSelectionIntent({
        intent: active.intent,
        scopeKey: "thread-1",
        lockedProvider: null,
        status: status({
          available: true,
          connectionState: {
            ...activeStatus.connectionState!,
            status: "failed",
            finishedAt: "2026-07-23T10:00:03.000Z",
            message: "Sign in failed.",
          },
        }),
      }),
    ).toEqual({ type: "clear", reason: "failed" });
  });

  it("does not mistake a stale terminal operation for the requested retry", () => {
    const staleFailure = status({
      connectionState: {
        operationId: "connect-old",
        method: "claude_account",
        status: "failed",
        startedAt: "2026-07-23T09:00:00.000Z",
        finishedAt: "2026-07-23T09:01:00.000Z",
        message: "Earlier failure.",
      },
    });
    const outcome = evaluateProviderSelectionIntent({
      intent: intent(staleFailure),
      scopeKey: "thread-1",
      lockedProvider: null,
      status: staleFailure,
    });
    expect(outcome.type).toBe("pending");
  });

  it("clears after a new installation attempt fails", () => {
    const outcome = evaluateProviderSelectionIntent({
      intent: intent(),
      scopeKey: "thread-1",
      lockedProvider: null,
      status: status({
        installationState: {
          operationId: "install-1",
          operation: "install",
          status: "failed",
          startedAt: "2026-07-23T10:00:01.000Z",
          finishedAt: "2026-07-23T10:00:03.000Z",
          message: "Install failed.",
        },
      }),
    });
    expect(outcome).toEqual({ type: "clear", reason: "failed" });
  });

  it("clears instead of overriding a thread that became provider-locked", () => {
    expect(
      evaluateProviderSelectionIntent({
        intent: intent(),
        scopeKey: "thread-1",
        lockedProvider: "codex",
        status: status({ status: "ready", available: true, authStatus: "authenticated" }),
      }),
    ).toEqual({ type: "clear", reason: "provider_locked" });
  });

  it("clears an intent when its owning composer scope changes", () => {
    expect(
      evaluateProviderSelectionIntent({
        intent: intent(),
        scopeKey: "thread-2",
        lockedProvider: null,
        status: status(),
      }),
    ).toEqual({ type: "clear", reason: "scope_changed" });
  });

  it("preserves a previous provider model, then uses the curated default, then catalog order", () => {
    const options = [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { slug: "claude-opus-5", name: "Claude Opus 5" },
    ];
    expect(
      resolvePostConnectionModel({
        provider: "claudeAgent",
        preferredModel: "claude-opus-5",
        options,
      }),
    ).toBe("claude-opus-5");
    expect(
      resolvePostConnectionModel({
        provider: "claudeAgent",
        preferredModel: "removed-model",
        options,
      }),
    ).toBe("claude-sonnet-5");
    expect(
      resolvePostConnectionModel({
        provider: "pi",
        preferredModel: null,
        options: [{ slug: "anthropic/claude-opus", name: "Claude Opus" }],
      }),
    ).toBe("anthropic/claude-opus");
  });
});
