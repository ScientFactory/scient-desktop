import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ClaudeInlineSetup } from "./ClaudeInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.170",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["claude_console"],
    canDisconnect: false,
    operation: null,
  },
  ...patch,
});

const runtimePlan: ProviderRuntimePlan = {
  instanceId: INSTANCE_ID,
  action: "install",
  target: "darwin-arm64",
  version: "2.1.170",
  downloadBytes: 1,
  sourceLabel: "Official Anthropic release",
  catalogRevision: "reviewed:2.1.170",
  message: "Install Claude.",
};

function controller(): ProviderLifecycleController {
  return {
    startConnection: vi.fn(async () => provider()),
    cancelConnection: vi.fn(async () => provider()),
    submitAuthorizationCode: vi.fn(async () => provider()),
    disconnect: vi.fn(async () => provider()),
    openAuthorizationPage: vi.fn(async () => undefined),
    planRuntime: vi.fn(async () => runtimePlan),
    startRuntime: vi.fn(async () => provider()),
    cancelRuntime: vi.fn(async () => provider()),
    updateExternalRuntime: vi.fn(async () => provider()),
  };
}

function render(value: ServerProvider): string {
  return renderToStaticMarkup(
    <ClaudeInlineSetup controller={controller()} displayName="Claude" provider={value} />,
  );
}

describe("ClaudeInlineSetup", () => {
  it("offers a private managed installation with OS-specific copy", () => {
    const markup = render(
      provider({
        installed: false,
        version: null,
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: {
            source: "missing",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["install"],
            managedVersion: null,
            previousManagedVersion: null,
            operation: null,
            message: "Scient can install Claude privately.",
          },
        },
      }),
    );

    expect(markup).toContain("Claude is not installed on this Mac.");
    expect(markup).toContain("Install Claude");
    expect(markup).toContain("Private and removable.");
  });

  it("shows the Console flow by default and the subscription flow only when offered", () => {
    const consoleMarkup = render(provider());
    expect(consoleMarkup).toContain("Connect your Anthropic Console account.");
    expect(consoleMarkup).toContain("Sign in with Console");
    expect(consoleMarkup).toContain("Scient never sees your password.");

    const subscriptionMarkup = render(
      provider({
        connection: {
          methods: ["claude_console", "claude_subscription"],
          canDisconnect: false,
          operation: null,
        },
      }),
    );
    expect(subscriptionMarkup).toContain("Sign in with your existing Claude subscription.");
    expect(subscriptionMarkup).toContain("Sign in to Claude");
  });

  it("keeps the exceptional one-time-code fallback collapsed during browser sign-in", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["claude_subscription"],
          canDisconnect: false,
          operation: {
            operationId: "connection-1",
            method: "claude_subscription",
            status: "waiting_for_browser",
            startedAt: "2026-08-09T08:00:00.000Z",
            finishedAt: null,
            message: "Finish sign in.",
            authorizationUrl: "https://claude.ai/oauth/authorize",
          },
        },
      }),
    );

    expect(markup).toContain("Finish signing in");
    expect(markup).toContain("Complete sign-in in your browser.");
    expect(markup).toContain("Reopen browser");
    expect(markup).toContain("Browser showed a code?");
    expect(markup).not.toContain("Claude one-time sign-in code");
  });

  it("distinguishes ready from authenticated-without-models", () => {
    const readyMarkup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true, label: "Claude Console" },
        models: [
          {
            slug: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            isCustom: false,
            capabilities: null,
          },
        ],
      }),
    );
    expect(readyMarkup).toContain("Claude is ready");
    expect(readyMarkup).toContain("Claude Console is connected.");

    const consoleWithSubscriptionAvailableMarkup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true, label: "Claude Console" },
        models: [
          {
            slug: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            isCustom: false,
            capabilities: null,
          },
        ],
        connection: {
          methods: ["claude_subscription", "claude_console"],
          canDisconnect: true,
          operation: null,
        },
      }),
    );
    expect(consoleWithSubscriptionAvailableMarkup).toContain("Claude Console is connected.");
    expect(consoleWithSubscriptionAvailableMarkup).not.toContain(
      "Your Claude subscription is connected.",
    );

    const noModelsMarkup = render(
      provider({ auth: { status: "authenticated", required: true, label: "Claude Console" } }),
    );
    expect(noModelsMarkup).toContain("Claude needs attention");
    expect(noModelsMarkup).toContain("did not report an available model");
  });

  it("turns failed installation and sign-in operations into retry states", () => {
    const installMarkup = render(
      provider({
        installed: false,
        version: null,
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: {
            source: "missing",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["install"],
            managedVersion: null,
            previousManagedVersion: null,
            operation: {
              operationId: "runtime-1",
              action: "install",
              status: "failed",
              startedAt: "2026-08-09T08:00:00.000Z",
              finishedAt: "2026-08-09T08:00:01.000Z",
              message: "The download could not be verified.",
            },
            message: "Installation failed.",
          },
        },
      }),
    );
    expect(installMarkup).toContain("Claude installation couldn’t finish");
    expect(installMarkup).toContain("Retry installation");

    const signInMarkup = render(
      provider({
        connection: {
          methods: ["claude_console"],
          canDisconnect: false,
          operation: {
            operationId: "connection-2",
            method: "claude_console",
            status: "failed",
            startedAt: "2026-08-09T08:00:00.000Z",
            finishedAt: "2026-08-09T08:00:01.000Z",
            message: "Claude did not confirm the account.",
          },
        },
      }),
    );
    expect(signInMarkup).toContain("Claude sign-in didn’t finish");
    expect(signInMarkup).toContain("Try sign in again");
  });
});
