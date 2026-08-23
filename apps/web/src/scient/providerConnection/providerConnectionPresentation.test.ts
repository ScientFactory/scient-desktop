import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  canManageProviderLifecycle,
  hasActiveProviderRuntimeOperation,
  isProviderAccountConnected,
  isSafeProviderAuthorizationUrl,
  needsManagedRuntimeRecovery,
  preferredProviderConnectionMethod,
  providerConnectionPresentation,
} from "./providerConnectionPresentation";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.147.0",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser", "codex_device_code"],
    canDisconnect: false,
    operation: null,
  },
};

describe("providerConnectionPresentation", () => {
  it("distinguishes disconnected, connecting, and connected states", () => {
    expect(providerConnectionPresentation(provider).kind).toBe("not-connected");
    expect(
      providerConnectionPresentation({
        ...provider,
        connection: {
          ...provider.connection!,
          operation: {
            operationId: "connect-1",
            method: "codex_browser",
            status: "waiting_for_browser",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: null,
            message: "Waiting",
            authorizationUrl: "https://auth.openai.com/",
          },
        },
      }).kind,
    ).toBe("connecting");
    expect(
      providerConnectionPresentation({
        ...provider,
        status: "ready",
        auth: { status: "authenticated", required: true },
      }).kind,
    ).toBe("connected");
  });

  it("does not ask for sign-in when the provider declares it unnecessary", () => {
    expect(
      providerConnectionPresentation({
        ...provider,
        auth: { status: "unauthenticated", required: false },
      }).kind,
    ).toBe("not-required");
  });

  it("surfaces managed runtime setup before authentication", () => {
    const missing: ServerProvider = {
      ...provider,
      installed: false,
      version: null,
      connection: {
        ...provider.connection!,
        runtime: {
          source: "missing",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["install"],
          managedVersion: null,
          previousManagedVersion: null,
          operation: null,
          message: "Scient can install Codex privately.",
        },
      },
    };
    expect(providerConnectionPresentation(missing).kind).toBe("not-installed");
    expect(canManageProviderLifecycle(missing)).toBe(true);
    expect(
      providerConnectionPresentation({
        ...missing,
        connection: {
          ...missing.connection!,
          runtime: {
            ...missing.connection!.runtime!,
            operation: {
              operationId: "runtime-1",
              action: "install",
              status: "downloading",
              startedAt: "2026-08-09T00:00:00.000Z",
              finishedAt: null,
              message: "Downloading",
              downloadedBytes: 10,
              totalBytes: 100,
            },
          },
        },
      }).kind,
    ).toBe("setting-up");
  });

  it("keeps runtime activity separate from the connected account state", () => {
    const repairing: ServerProvider = {
      ...provider,
      auth: { status: "authenticated", required: true, label: "Google account" },
      connection: {
        ...provider.connection!,
        runtime: {
          source: "scient_managed",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["repair", "remove"],
          managedVersion: "1.1.17",
          previousManagedVersion: null,
          operation: {
            operationId: "runtime-repair-1",
            action: "repair",
            status: "verifying",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: null,
            message: "Verifying Antigravity.",
          },
          message: "Managed Antigravity is ready.",
        },
      },
    };

    expect(providerConnectionPresentation(repairing).kind).toBe("setting-up");
    expect(hasActiveProviderRuntimeOperation(repairing)).toBe(true);
    expect(isProviderAccountConnected(repairing)).toBe(true);
  });

  it("routes a broken managed executable to repair instead of account sign-in", () => {
    const managedRuntime = {
      source: "scient_managed" as const,
      supportTier: "fully_assisted" as const,
      target: "win32-arm64",
      actions: ["repair", "remove"] as const,
      managedVersion: "2.1.170",
      previousManagedVersion: null,
      operation: null,
      message: "Scient is using an app-private, verified Claude runtime.",
    };
    expect(
      needsManagedRuntimeRecovery({
        ...provider,
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "error",
        auth: { status: "unknown", required: true },
        message: "Claude is installed but failed to run.",
        connection: { ...provider.connection!, runtime: managedRuntime },
      }),
    ).toBe(true);
    expect(
      needsManagedRuntimeRecovery({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated", required: true },
        message: "Codex CLI is not authenticated.",
        connection: { ...provider.connection!, runtime: managedRuntime },
      }),
    ).toBe(false);
    expect(
      needsManagedRuntimeRecovery({
        ...provider,
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "ready",
        auth: { status: "authenticated", required: true },
        models: [
          {
            slug: "claude-fable-5",
            name: "Claude Fable 5",
            isCustom: false,
            capabilities: null,
          },
        ],
        connection: {
          ...provider.connection!,
          runtime: {
            ...managedRuntime,
            operation: {
              operationId: "failed-update",
              action: "update",
              status: "failed",
              startedAt: "2026-08-09T00:00:00.000Z",
              finishedAt: "2026-08-09T00:00:01.000Z",
              message: "The update failed; the previous version is still active.",
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("prefers browser login and only permits HTTPS authorization URLs", () => {
    expect(preferredProviderConnectionMethod(provider)).toBe("codex_browser");
    expect(isSafeProviderAuthorizationUrl("https://auth.openai.com/device")).toBe(true);
    expect(isSafeProviderAuthorizationUrl("http://auth.openai.com/device")).toBe(false);
    expect(isSafeProviderAuthorizationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeProviderAuthorizationUrl("not a URL")).toBe(false);
  });

  it("prefers a Claude subscription before the console fallback", () => {
    expect(
      preferredProviderConnectionMethod({
        ...provider,
        driver: ProviderDriverKind.make("claudeAgent"),
        connection: {
          ...provider.connection!,
          methods: ["claude_console", "claude_subscription"],
        },
      }),
    ).toBe("claude_subscription");
  });

  it("selects Droid's advertised ACP device-pairing method", () => {
    expect(
      preferredProviderConnectionMethod({
        ...provider,
        driver: ProviderDriverKind.make("droid"),
        connection: {
          ...provider.connection!,
          methods: ["droid_device_pairing"],
        },
      }),
    ).toBe("droid_device_pairing");
  });

  it("selects Cursor browser sign in when the driver advertises it", () => {
    expect(
      preferredProviderConnectionMethod({
        ...provider,
        driver: ProviderDriverKind.make("cursor"),
        connection: {
          ...provider.connection!,
          methods: ["cursor_browser"],
        },
      }),
    ).toBe("cursor_browser");
  });
});
