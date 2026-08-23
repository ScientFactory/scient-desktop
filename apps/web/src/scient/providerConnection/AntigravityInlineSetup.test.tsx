import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AntigravityInlineSetup } from "./AntigravityInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("antigravity");

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "1.1.17",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-22T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["antigravity_google"],
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
  } as unknown as ProviderLifecycleController;
}

function render(value: ServerProvider): string {
  return renderToStaticMarkup(
    <AntigravityInlineSetup controller={controller()} displayName="Antigravity" provider={value} />,
  );
}

describe("AntigravityInlineSetup", () => {
  it("renders installation guidance when CLI is not installed", () => {
    const markup = render(
      provider({
        installed: false,
        version: null,
      }),
    );

    expect(markup).toContain("Install Antigravity");
    expect(markup).toContain("https://antigravity.google/cli/install.sh");
  });

  it("renders Google sign-in button when installed but unauthenticated", () => {
    const markup = render(
      provider({
        message:
          "Antigravity is not authenticated. Start the Antigravity sign-in flow and complete Google sign-in.",
      }),
    );

    expect(markup).toContain("Antigravity is installed");
    expect(markup).toContain("Sign in with Google");
    expect(markup).toContain(
      "Sign in with the Google account for your existing subscription. Scient never sees your password.",
    );
    expect(markup).not.toContain("Antigravity owns the sign-in");
    expect(markup).not.toContain("Start the Antigravity sign-in flow");
  });

  it("preserves actionable API-key-mode recovery guidance", () => {
    const markup = render(
      provider({
        message:
          "Antigravity is configured for Gemini API-key mode. Remove `modelProvider`, then sign in with Google.",
      }),
    );

    expect(markup).toContain("configured for Gemini API-key mode");
    expect(markup).toContain("Remove `modelProvider`");
  });

  it("never offers duplicate sign-in while account state is unknown", () => {
    const markup = render(
      provider({
        auth: { status: "unknown", required: true },
        message: "Account check is still in progress.",
      }),
    );

    expect(markup).toContain("Couldn’t verify your Google account");
    expect(markup).toContain("Account check is still in progress");
    expect(markup).not.toContain("Sign in with Google");
  });

  it("renders in-flight connection view when signing in", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: {
            operationId: "op-sign-in-1",
            method: "antigravity_google",
            status: "waiting_for_browser",
            startedAt: "2026-08-22T08:00:00.000Z",
            finishedAt: null,
            message: "Finish Google sign-in.",
          },
        },
      }),
    );

    expect(markup).toContain("Finish signing in");
    expect(markup).toContain("official Antigravity sign-in");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("text-destructive/80");
  });

  it("keeps managed installation compact without synthetic progress", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "1.1.19",
            previousManagedVersion: null,
            operation: {
              operationId: "runtime-install-1",
              action: "install",
              status: "downloading",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: null,
              message: "Downloading Antigravity.",
              downloadedBytes: 10,
              totalBytes: 100,
            },
            message: "Installing Antigravity.",
          },
        },
      }),
    );

    expect(markup).toContain("Downloading Antigravity from Google");
    expect(markup).toContain(" Cancel</button>");
    expect(markup).not.toContain("progressbar");
    expect(markup).not.toContain('style="width:');
  });

  it("shows a paste-code field for the live Google authorization flow", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: {
            operationId: "op-google-code",
            method: "antigravity_google",
            status: "waiting_for_browser",
            startedAt: "2026-08-22T08:00:00.000Z",
            finishedAt: null,
            message: "Finish Google sign-in.",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
            authorizationUrlKind: "primary",
          },
        },
      }),
    );

    expect(markup).toContain("Reopen Google sign-in");
    expect(markup).toContain("Paste the code Google shows after sign in");
    expect(markup).toContain("Paste authorization code");
    expect(markup).toContain("Antigravity one-time authorization code");
  });

  it("does not invent a paste-code step when the live provider process cannot accept it", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: {
            operationId: "op-browser-only",
            method: "antigravity_google",
            status: "waiting_for_browser",
            startedAt: "2026-08-22T08:00:00.000Z",
            finishedAt: null,
            message: "Finish Google sign-in.",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
            authorizationUrlKind: "primary",
            acceptsAuthorizationCode: false,
          },
        },
      }),
    );

    expect(markup).toContain("Reopen Google sign-in");
    expect(markup).not.toContain("Paste authorization code");
  });

  it("renders connected and ready view with default model and CLI version", () => {
    const markup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true },
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: true,
          operation: null,
        },
        version: "1.1.17",
        models: [
          {
            slug: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
          {
            slug: "gemini-3.1-pro",
            name: "Gemini 3.1 Pro",
            isCustom: false,
            capabilities: null,
          },
        ],
      }),
    );

    expect(markup).toContain("Antigravity is ready");
    expect(markup).toContain("1.1.17");
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Google account is connected");
    expect(markup).toContain('href="https://one.google.com/settings"');
    expect(markup).toContain('aria-label="Google account settings (opens in browser)"');
    expect(markup).toContain("Default model: Gemini 3.7 Flash");
    expect(markup).toContain(">Sign out<");
  });

  it("trusts confirmed authentication over a stale in-flight sign-in operation", () => {
    const markup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true },
        models: [
          {
            slug: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: true,
          operation: {
            operationId: "stale-sign-in",
            method: "antigravity_google",
            status: "waiting_for_browser",
            startedAt: "2026-08-22T08:00:00.000Z",
            finishedAt: null,
            message: "Finish Google sign-in.",
            acceptsAuthorizationCode: true,
          },
        },
      }),
    );

    expect(markup).toContain("Antigravity is ready");
    expect(markup).not.toContain("Finish signing in");
    expect(markup).not.toContain("Paste authorization code");
  });

  it("returns to the stable ready state after repair", () => {
    const markup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true },
        models: [
          {
            slug: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: true,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "1.1.17",
            previousManagedVersion: null,
            operation: {
              operationId: "repair-1",
              action: "repair",
              status: "succeeded",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: "2026-08-22T08:00:05.000Z",
              message: "The provider runtime was repaired and verified successfully.",
            },
            message: "Managed Antigravity is ready.",
          },
        },
      }),
    );

    expect(markup).toContain("Antigravity is ready");
    expect(markup).not.toContain("repaired successfully");
    expect(markup).not.toContain("repaired and verified successfully");
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Google account is connected");
  });

  it("labels the documentation fallback as sign-in help", () => {
    const markup = render(
      provider({
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: {
            operationId: "op-sign-in-help",
            method: "antigravity_google",
            status: "waiting_for_browser",
            startedAt: "2026-08-22T08:00:00.000Z",
            finishedAt: null,
            message: "Finish Google sign-in.",
            authorizationUrl:
              "https://antigravity.google/docs/cli/install/#authentication-workflows",
            authorizationUrlKind: "manual_fallback",
          },
        },
      }),
    );

    expect(markup).toContain("Open sign-in help");
    expect(markup).not.toContain("Browser didn’t open?");
    expect(markup).not.toContain("Paste authorization code");
  });

  it("shows update banner when a reviewed managed update is available", () => {
    const markup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true },
        version: "1.1.16",
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: true,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["update", "repair", "remove"],
            managedVersion: "1.1.16",
            previousManagedVersion: null,
            operation: null,
            message: "Reviewed update available.",
          },
        },
        models: [
          {
            slug: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
      }),
    );

    expect(markup).toContain("Antigravity update available");
    expect(markup).toContain("Update Antigravity");
  });

  it("offers one-click reviewed installation when the managed runtime allows it", () => {
    const markup = render(
      provider({
        installed: false,
        version: null,
        connection: {
          methods: ["antigravity_google"],
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
            message: "Reviewed Google release available.",
          },
        },
      }),
    );

    expect(markup).toContain("Scient can install a reviewed official Google CLI privately");
    expect(markup).toContain("Install Antigravity");
  });

  it("shows removal progress instead of briefly claiming the provider is ready", () => {
    const markup = render(
      provider({
        status: "ready",
        auth: { status: "authenticated", required: true },
        models: [
          {
            slug: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: true,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: [],
            managedVersion: "1.1.17",
            previousManagedVersion: null,
            operation: {
              operationId: "remove-active",
              action: "remove",
              status: "removing",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: null,
              message: "Removing managed Antigravity.",
            },
            message: "Removing managed Antigravity.",
          },
        },
      }),
    );

    expect(markup).toContain("Removing Antigravity");
    expect(markup).not.toContain("Antigravity is ready");
  });

  it("confirms successful removal instead of immediately prompting reinstallation", () => {
    const markup = render(
      provider({
        installed: false,
        version: null,
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: null,
          runtime: {
            source: "missing",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["install"],
            managedVersion: null,
            previousManagedVersion: "1.1.17",
            operation: {
              operationId: "remove-succeeded",
              action: "remove",
              status: "succeeded",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: "2026-08-22T08:00:05.000Z",
              message: "Scient’s private Antigravity copy was removed.",
            },
            message: "Antigravity can be installed again.",
          },
        },
      }),
    );

    expect(markup).toContain("Antigravity removed");
    expect(markup).toContain("private Antigravity copy was removed");
    expect(markup).toContain("Install again");
    expect(markup).not.toContain("Install Antigravity");
  });
});
