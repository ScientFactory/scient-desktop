import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { startGrokSignIn } from "./grokLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("grok"),
  driver: ProviderDriverKind.make("grok"),
  enabled: true,
  installed: true,
  version: "1.0.5",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["grok_account", "grok_device_code"],
    canDisconnect: false,
    operation: {
      operationId: "grok-login-1",
      method: "grok_account",
      status: "waiting_for_browser",
      startedAt: "2026-08-23T08:00:00.000Z",
      finishedAt: null,
      message: "Finish sign in.",
      authorizationUrl: "https://accounts.x.ai/oauth",
      authorizationUrlKind: "manual_fallback",
    },
  },
};

describe("Grok lifecycle actions", () => {
  it("starts account sign in without duplicating Grok's browser launch", async () => {
    const startConnection = vi.fn(async () => provider);
    const openAuthorizationPage = vi.fn(async () => undefined);
    const controller = {
      startConnection,
      openAuthorizationPage,
    } as unknown as ProviderLifecycleController;

    await startGrokSignIn(controller);

    expect(startConnection).toHaveBeenCalledWith("grok_account", "connect");
    expect(openAuthorizationPage).not.toHaveBeenCalled();
  });

  it("uses reauthentication when switching from an API key to a subscription", async () => {
    const startConnection = vi.fn(async () => provider);
    const controller = {
      startConnection,
      openAuthorizationPage: vi.fn(async () => undefined),
    } as unknown as ProviderLifecycleController;

    await startGrokSignIn(controller, "grok_account", true);

    expect(startConnection).toHaveBeenCalledWith("grok_account", "reauthenticate");
  });
});
