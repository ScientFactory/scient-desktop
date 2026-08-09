import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  canManageProviderLifecycle,
  isSafeProviderAuthorizationUrl,
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

  it("prefers browser login and only permits HTTPS authorization URLs", () => {
    expect(preferredProviderConnectionMethod(provider)).toBe("codex_browser");
    expect(isSafeProviderAuthorizationUrl("https://auth.openai.com/device")).toBe(true);
    expect(isSafeProviderAuthorizationUrl("http://auth.openai.com/device")).toBe(false);
    expect(isSafeProviderAuthorizationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeProviderAuthorizationUrl("not a URL")).toBe(false);
  });
});
