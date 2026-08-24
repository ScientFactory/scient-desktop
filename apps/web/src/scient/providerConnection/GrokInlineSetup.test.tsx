import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { GrokInlineSetup } from "./GrokInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("grok");

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("grok"),
  enabled: true,
  installed: true,
  version: "1.0.5",
  status: "warning",
  auth: { status: "unauthenticated", required: true, type: "grok_account" },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["grok_account", "grok_device_code"],
    canDisconnect: false,
    operation: null,
  },
  ...patch,
});

function controller(): ProviderLifecycleController {
  return {
    startConnection: vi.fn(async () => provider()),
    cancelConnection: vi.fn(async () => provider()),
    submitAuthorizationCode: vi.fn(async () => provider()),
    disconnect: vi.fn(async () => provider()),
    openAuthorizationPage: vi.fn(async () => undefined),
    planRuntime: vi.fn(async () => {
      throw new Error("unsupported");
    }),
    startRuntime: vi.fn(async () => provider()),
    cancelRuntime: vi.fn(async () => provider()),
    updateExternalRuntime: vi.fn(async () => provider()),
  };
}

function render(value: ServerProvider): string {
  return renderToStaticMarkup(
    <GrokInlineSetup controller={controller()} displayName="Grok" provider={value} />,
  );
}

describe("GrokInlineSetup", () => {
  it("offers a reviewed private install when Grok is missing", () => {
    const markup = render(
      provider({
        installed: false,
        version: null,
        connection: {
          methods: ["grok_account", "grok_device_code"],
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
            message: "Scient can install Grok privately.",
          },
        },
      }),
    );

    expect(markup).toContain("Install Grok");
    expect(markup).toContain("reviewed official Grok Build runtime");
    expect(markup).toContain("dark:fill-[#F5F5F5]");
  });

  it("keeps browser and device sign in concise", () => {
    const markup = render(provider());

    expect(markup).toContain("Sign in required");
    expect(markup).toContain(
      "Sign in with your existing Grok subscription. Scient never sees your password.",
    );
    expect(markup).toContain("Sign in with Grok");
    expect(markup).toContain("Use device code");
    expect(markup).not.toContain("Grok owns the secure flow");
    expect(markup).not.toContain("card");
  });

  it("shows a device code without an authorization-code form", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["grok_account", "grok_device_code"],
          canDisconnect: false,
          operation: {
            operationId: "grok-device-1",
            method: "grok_device_code",
            status: "waiting_for_device_code",
            startedAt: "2026-08-23T08:00:00.000Z",
            finishedAt: null,
            message: "Enter the device code.",
            authorizationUrl: "https://accounts.x.ai/device?user_code=GROK-1234",
            authorizationUrlKind: "manual_fallback",
            userCode: "GROK-1234",
            acceptsAuthorizationCode: false,
          },
        },
      }),
    );

    expect(markup).toContain("GROK-1234");
    expect(markup).toContain("dark:fill-[#F5F5F5]");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:inline-flex");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:max-w-64");
    expect(markup).not.toContain("Paste authorization code");
    expect(markup).toContain("Open sign-in page");
    expect(markup).toContain("Cancel");
  });

  it("keeps optional paste-code recovery collapsed for a live loopback flow", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["grok_account", "grok_device_code"],
          canDisconnect: false,
          operation: {
            operationId: "grok-loopback-1",
            method: "grok_account",
            status: "waiting_for_browser",
            startedAt: "2026-08-23T08:00:00.000Z",
            finishedAt: null,
            message: "Finish sign in.",
            authorizationUrl: "https://accounts.x.ai/oauth",
            authorizationUrlKind: "manual_fallback",
            acceptsAuthorizationCode: true,
          },
        },
      }),
    );

    expect(markup).toContain("Have a sign-in code?");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Paste sign-in code");
    expect(markup).not.toContain("Grok one-time authorization code");
  });

  it("distinguishes a subscription from API-key readiness", () => {
    const accountMarkup = render(
      provider({
        status: "ready",
        auth: {
          status: "authenticated",
          required: true,
          type: "grok_account",
          email: "scientist@example.com",
          label: "SuperGrok",
        },
      }),
    );
    const apiKeyMarkup = render(
      provider({
        status: "ready",
        auth: {
          status: "authenticated",
          required: true,
          type: "api_key",
          label: "xAI API key",
        },
      }),
    );

    expect(accountMarkup).toContain("Grok is ready");
    expect(accountMarkup).toContain("scientist@example.com is connected");
    expect(apiKeyMarkup).toContain("Ready via API key");
    expect(apiKeyMarkup).toContain("Use a Grok subscription");
    expect(apiKeyMarkup).not.toContain("Sign out");
  });
});
