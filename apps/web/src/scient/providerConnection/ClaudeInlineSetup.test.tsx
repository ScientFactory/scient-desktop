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
    methods: ["claude_subscription", "claude_console"],
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
  it("keeps managed installation compact without synthetic progress", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "2.1.170",
            previousManagedVersion: null,
            operation: {
              operationId: "runtime-repair",
              action: "repair",
              status: "verifying",
              startedAt: "2026-08-09T08:00:00.000Z",
              finishedAt: null,
              message: "Verifying Claude.",
            },
            message: "Scient is using managed Claude.",
          },
        },
      }),
    );

    expect(markup).toContain("Repairing Claude");
    expect(markup).toContain("Verifying the download…");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("text-destructive/80");
    expect(markup).not.toContain("progressbar");
    expect(markup).toContain("space-y-3 px-6 pb-4");
  });

  it("offers a managed installation with OS-specific copy", () => {
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
    expect(markup).not.toContain("Private and removable.");
  });

  it("shows subscription login by default and preserves the Console fallback", () => {
    const subscriptionMarkup = render(provider());
    expect(subscriptionMarkup).toContain(
      "Sign in with your existing Claude subscription. Scient never sees your password.",
    );
    expect(subscriptionMarkup).toContain("Sign in to Claude");
    expect(subscriptionMarkup).toContain("Use Anthropic Console");
    expect(subscriptionMarkup).toContain("Scient never sees your password.");
    expect(subscriptionMarkup).not.toContain("The secure flow opens in your browser");

    const consoleMarkup = render(
      provider({
        connection: {
          methods: ["claude_console"],
          canDisconnect: false,
          operation: null,
        },
      }),
    );
    expect(consoleMarkup).toContain(
      "Connect your Anthropic Console account. Scient never sees your password.",
    );
    expect(consoleMarkup).toContain("Sign in with Console");
  });

  it("keeps fallback-code recovery available while Claude verifies the account", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["claude_subscription"],
          canDisconnect: false,
          operation: {
            operationId: "connection-verify",
            method: "claude_subscription",
            status: "verifying",
            startedAt: "2026-08-09T08:00:00.000Z",
            finishedAt: null,
            message: "Checking account.",
            authorizationUrl: "https://claude.ai/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
          },
        },
      }),
    );

    expect(markup).toContain("Checking your account");
    expect(markup).toContain("Browser didn’t open?");
    expect(markup).toContain("Have a sign-in code?");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Claude one-time sign-in code");
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
            authorizationUrlKind: "manual_fallback",
          },
        },
      }),
    );

    expect(markup).toContain("Finish signing in");
    expect(markup).toContain("Complete sign-in in your browser.");
    expect(markup).toContain("Browser didn’t open?");
    expect(markup).toContain("Have a sign-in code?");
    expect(markup).toContain('aria-expanded="false"');
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
    expect(readyMarkup.replace(/<[^>]+>/g, "")).toContain("Claude Console is connected.");
    expect(readyMarkup).not.toContain('href="https://claude.ai/settings/billing"');

    const subscriptionReadyMarkup = render(
      provider({
        status: "ready",
        auth: {
          status: "authenticated",
          required: true,
          label: "Claude Enterprise Subscription",
        },
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
    expect(subscriptionReadyMarkup).toContain('href="https://claude.ai/settings/billing"');
    expect(subscriptionReadyMarkup).toContain(
      'aria-label="Claude Enterprise Subscription settings (opens in browser)"',
    );

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
    expect(consoleWithSubscriptionAvailableMarkup.replace(/<[^>]+>/g, "")).toContain(
      "Claude Console is connected.",
    );
    expect(consoleWithSubscriptionAvailableMarkup).not.toContain(
      "Your Claude subscription is connected.",
    );

    const noModelsMarkup = render(
      provider({ auth: { status: "authenticated", required: true, label: "Claude Console" } }),
    );
    expect(noModelsMarkup).toContain("Claude needs attention");
    expect(noModelsMarkup).toContain("did not report an available model");

    const incompleteReadinessMarkup = render(
      provider({
        status: "warning",
        auth: { status: "authenticated", required: true, label: "Claude subscription" },
        models: [
          {
            slug: "claude-fable-5",
            name: "Claude Fable 5",
            isCustom: false,
            capabilities: null,
          },
        ],
        message: "Claude is signed in, but Scient could not complete its readiness check.",
      }),
    );
    expect(incompleteReadinessMarkup).toContain("Claude needs attention");
    expect(incompleteReadinessMarkup).toContain(
      "Claude is signed in, but Scient could not complete its readiness check.",
    );
    expect(incompleteReadinessMarkup).not.toContain("Claude is ready");
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

  it("offers repair when the canonical probe rejects an existing managed runtime", () => {
    const markup = render(
      provider({
        status: "error",
        auth: { status: "unknown", required: true },
        message: "Claude is installed but failed to run.",
        connection: {
          methods: ["claude_subscription"],
          canDisconnect: false,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "win32-arm64",
            actions: ["repair", "remove"],
            managedVersion: "2.1.170",
            previousManagedVersion: null,
            operation: null,
            message: "Scient is using an app-private Claude runtime.",
          },
        },
      }),
    );

    expect(markup).toContain("Claude needs repair");
    expect(markup).toContain("Claude is installed but failed to run.");
    expect(markup).toContain("Repair Claude");
    expect(markup).not.toContain("Sign in to Claude");
  });

  it("offers optional repair for a healthy managed Claude runtime", () => {
    const markup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true, label: "Claude subscription" },
        models: [
          {
            slug: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            isCustom: false,
            capabilities: null,
          },
        ],
        connection: {
          methods: ["claude_subscription"],
          canDisconnect: true,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "2.1.170",
            previousManagedVersion: null,
            operation: null,
            message: "Scient is using managed Claude.",
          },
        },
      }),
    );

    expect(markup).toContain("Repair</button>");
  });

  it("retries the account type that actually failed and offers the other route", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["claude_subscription", "claude_console"],
          canDisconnect: false,
          operation: {
            operationId: "connection-console-failed",
            method: "claude_console",
            status: "failed",
            startedAt: "2026-08-09T08:00:00.000Z",
            finishedAt: "2026-08-09T08:00:01.000Z",
            message: "Console sign-in was not completed.",
          },
        },
      }),
    );

    expect(markup).toContain("Console sign-in was not completed.");
    expect(markup).toContain("Use Claude subscription");
  });
});
