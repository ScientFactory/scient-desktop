import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CONNECTION_METHOD_OPTIONS,
  describeProviderConnection,
  providerConnectionMethod,
  providerInstallUrl,
} from "./providerConnectionPresentation";

const BASE_STATUS: ServerProviderStatus = {
  provider: "codex",
  status: "error",
  available: true,
  authStatus: "unauthenticated",
  checkedAt: "2026-07-19T10:00:00.000Z",
};

describe("provider connection presentation", () => {
  it("maps supported providers to fixed browser sign-in methods", () => {
    expect(providerConnectionMethod("codex")).toBe("codex_browser");
    expect(providerConnectionMethod("claudeAgent")).toBe("claude_account");
    expect(providerConnectionMethod("cursor")).toBe("cursor_browser");
    expect(providerConnectionMethod("antigravity")).toBe("antigravity_browser");
    expect(providerConnectionMethod("grok")).toBe("grok_browser");
    expect(providerConnectionMethod("droid")).toBe("droid_device_pairing");
    expect(providerConnectionMethod("opencode")).toBeNull();
  });

  it("offers official installation guidance when a CLI is missing", () => {
    const presentation = describeProviderConnection("codex", {
      ...BASE_STATUS,
      available: false,
      authStatus: "unknown",
    });
    expect(presentation.primaryAction).toBe("open_install_guide");
    expect(providerInstallUrl("codex")).toMatch(/^https:\/\//u);
  });

  it("offers dependency-free managed installation when a reviewed artifact exists", () => {
    const presentation = describeProviderConnection("codex", {
      ...BASE_STATUS,
      available: false,
      authStatus: "unknown",
      runtime: {
        source: "missing",
        managedVersion: null,
        canInstall: true,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: "No usable provider runtime was found.",
      },
    });
    expect(presentation.primaryAction).toBe("install");
    expect(presentation.description).toContain("no Homebrew");
  });

  it("offers browser login without asking for credentials", () => {
    const presentation = describeProviderConnection("codex", BASE_STATUS);
    expect(presentation.primaryAction).toBe("sign_in");
    expect(presentation.primaryLabel).toBe("Continue in browser");
    expect(presentation.description).toContain("credentials stay with Codex");
  });

  it("offers terminal-equivalent Claude sign-in with explicit alternatives", () => {
    const presentation = describeProviderConnection("claudeAgent", {
      ...BASE_STATUS,
      provider: "claudeAgent",
    });
    expect(presentation.primaryAction).toBe("sign_in");
    expect(presentation.primaryLabel).toBe("Connect Claude");
    expect(presentation.description).toContain("already connected in your terminal");
    expect(CLAUDE_CONNECTION_METHOD_OPTIONS.map((option) => option.method)).toEqual([
      "claude_account",
      "claude_sso",
      "claude_console",
    ]);
  });

  it.each(["starting", "waiting_for_browser", "verifying"] as const)(
    "keeps %s operations cancellable and restartable",
    (operationStatus) => {
      const presentation = describeProviderConnection("codex", {
        ...BASE_STATUS,
        connectionState: {
          operationId: "operation-1",
          method: "codex_browser",
          status: operationStatus,
          startedAt: "2026-07-19T10:00:00.000Z",
          finishedAt: null,
          message: "Waiting safely.",
        },
      });
      expect(presentation.busy).toBe(true);
      expect(presentation.canCancel).toBe(true);
      expect(presentation.primaryAction).toBe("done");
      expect(presentation.canRestart).toBe(true);
    },
  );

  it("reports verified providers as done", () => {
    const presentation = describeProviderConnection("claudeAgent", {
      ...BASE_STATUS,
      provider: "claudeAgent",
      status: "ready",
      authStatus: "authenticated",
    });
    expect(presentation.primaryAction).toBe("done");
    expect(presentation.description).toContain("ready to use");
  });

  it("trusts current health over a stale terminal operation", () => {
    const presentation = describeProviderConnection("codex", {
      ...BASE_STATUS,
      status: "ready",
      authStatus: "authenticated",
      connectionState: {
        operationId: "operation-1",
        method: "codex_browser",
        status: "failed",
        startedAt: "2026-07-19T10:00:00.000Z",
        finishedAt: "2026-07-19T10:01:00.000Z",
        message: "Older failure.",
      },
    });
    expect(presentation.primaryAction).toBe("done");
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps a forced recovery retryable after a %s attempt despite stale authenticated health",
    (operationStatus) => {
      const presentation = describeProviderConnection(
        "codex",
        {
          ...BASE_STATUS,
          status: "ready",
          authStatus: "authenticated",
          requiresProviderAccount: true,
          connectionState: {
            operationId: "recovery-operation-1",
            method: "codex_browser",
            status: operationStatus,
            startedAt: "2026-07-19T10:00:00.000Z",
            finishedAt: "2026-07-19T10:01:00.000Z",
            message: `Recovery ${operationStatus}.`,
          },
        },
        { forceReconnect: true },
      );

      expect(presentation.primaryAction).toBe("sign_in");
      expect(presentation.primaryLabel).toBe("Try again");
    },
  );

  it("never offers account recovery when Codex account ownership is unknown or custom", () => {
    for (const requiresProviderAccount of [undefined, false] as const) {
      const presentation = describeProviderConnection(
        "codex",
        {
          ...BASE_STATUS,
          status: "ready",
          authStatus: "authenticated",
          requiresProviderAccount,
        },
        { forceReconnect: true },
      );
      expect(presentation.primaryAction).toBe("check_again");
    }
  });

  it("turns failures into a safe retry", () => {
    const presentation = describeProviderConnection("codex", {
      ...BASE_STATUS,
      connectionState: {
        operationId: "operation-1",
        method: "codex_browser",
        status: "failed",
        startedAt: "2026-07-19T10:00:00.000Z",
        finishedAt: "2026-07-19T10:01:00.000Z",
        message: "Sign in was not completed.",
      },
    });
    expect(presentation.primaryAction).toBe("sign_in");
    expect(presentation.primaryLabel).toBe("Try again");
  });

  it("turns a rejected Grok OAuth operation into a fresh browser retry", () => {
    const presentation = describeProviderConnection("grok", {
      ...BASE_STATUS,
      provider: "grok",
      connectionState: {
        operationId: "grok-oauth-1",
        method: "grok_browser",
        status: "failed",
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:01:00.000Z",
        message: "Grok authorization was not completed.",
      },
    });

    expect(presentation.primaryAction).toBe("sign_in");
    expect(presentation.primaryLabel).toBe("Try again");
    expect(presentation.description).toContain("Grok authorization");
  });
});
