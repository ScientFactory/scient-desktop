import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  cancelAntigravitySignIn,
  hasManagedAntigravityUpdate,
  startAntigravitySignIn,
  startAntigravitySignInAndOpenAuthorizationPage,
  startReviewedAntigravityRuntimeAction,
  updateAntigravityRuntime,
} from "./antigravityLifecycleActions";
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
  connection: { methods: ["antigravity_google"], canDisconnect: false, operation: null },
  ...patch,
});

function controller(overrides: Partial<ProviderLifecycleController> = {}) {
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
    ...overrides,
  } as unknown as ProviderLifecycleController;
}

describe("Antigravity lifecycle actions", () => {
  it("starts sign-in using the antigravity_google method", async () => {
    const lifecycle = controller();
    await startAntigravitySignIn(lifecycle);
    expect(lifecycle.startConnection).toHaveBeenCalledWith("antigravity_google");
  });

  it("connects the advertised credential method without opening a browser", async () => {
    const current = provider({
      connection: { methods: ["antigravity_credentials"], canDisconnect: false, operation: null },
    });
    const lifecycle = controller({ startConnection: vi.fn(async () => current) });
    await startAntigravitySignInAndOpenAuthorizationPage(lifecycle, current);
    expect(lifecycle.startConnection).toHaveBeenCalledWith("antigravity_credentials");
    expect(lifecycle.openAuthorizationPage).not.toHaveBeenCalled();
  });

  it("opens the primary Google authorization page after starting sign-in", async () => {
    const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test";
    const lifecycle = controller({
      startConnection: vi.fn(async () =>
        provider({
          connection: {
            methods: ["antigravity_google"],
            canDisconnect: false,
            operation: {
              operationId: "op-primary",
              method: "antigravity_google",
              status: "waiting_for_browser",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: null,
              message: "Finish Google sign-in.",
              authorizationUrl,
              authorizationUrlKind: "primary",
            },
          },
        }),
      ),
    });

    await startAntigravitySignInAndOpenAuthorizationPage(lifecycle);

    expect(lifecycle.openAuthorizationPage).toHaveBeenCalledWith(authorizationUrl);
  });

  it("does not open documentation fallback as though it were Google sign-in", async () => {
    const lifecycle = controller({
      startConnection: vi.fn(async () =>
        provider({
          connection: {
            methods: ["antigravity_google"],
            canDisconnect: false,
            operation: {
              operationId: "op-fallback",
              method: "antigravity_google",
              status: "waiting_for_browser",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: null,
              message: "Open sign-in help.",
              authorizationUrl:
                "https://antigravity.google/docs/cli/install/#authentication-workflows",
              authorizationUrlKind: "manual_fallback",
            },
          },
        }),
      ),
    });

    await startAntigravitySignInAndOpenAuthorizationPage(lifecycle);

    expect(lifecycle.openAuthorizationPage).not.toHaveBeenCalled();
  });

  it("cancels in-flight sign in", async () => {
    const lifecycle = controller();
    await cancelAntigravitySignIn(lifecycle, "op-123");
    expect(lifecycle.cancelConnection).toHaveBeenCalledWith("op-123");
  });

  it("plans and starts a reviewed managed installation", async () => {
    const plan: ProviderRuntimePlan = {
      instanceId: INSTANCE_ID,
      action: "install" as const,
      target: "darwin-arm64",
      version: "1.1.17",
      downloadBytes: 49_401_949,
      sourceLabel: "Official Google Antigravity CLI release",
      catalogRevision: "google-antigravity-cli:1.1.17:test",
      message: "Install reviewed release.",
    };
    const lifecycle = controller({
      planRuntime: vi.fn(async () => plan),
      startRuntime: vi.fn(async () => provider()),
    });

    await startReviewedAntigravityRuntimeAction(lifecycle, "install");
    expect(lifecycle.planRuntime).toHaveBeenCalledWith("install");
    expect(lifecycle.startRuntime).toHaveBeenCalledWith(plan);
  });

  it("prefers a reviewed managed update over an external update", async () => {
    const current = provider({
      connection: {
        methods: ["antigravity_google"],
        canDisconnect: false,
        operation: null,
        runtime: {
          source: "scient_managed",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["update", "repair", "remove"],
          managedVersion: "1.1.16",
          previousManagedVersion: null,
          operation: null,
          message: "Update available.",
        },
      },
    });
    const plan: ProviderRuntimePlan = {
      instanceId: INSTANCE_ID,
      action: "update" as const,
      target: "darwin-arm64",
      version: "1.1.17",
      downloadBytes: 49_401_949,
      sourceLabel: "Official Google Antigravity CLI release",
      catalogRevision: "google-antigravity-cli:1.1.17:test",
      message: "Update reviewed release.",
    };
    const lifecycle = controller({
      planRuntime: vi.fn(async () => plan),
      startRuntime: vi.fn(async () => provider()),
    });

    expect(hasManagedAntigravityUpdate(current)).toBe(true);
    await updateAntigravityRuntime(lifecycle, current);
    expect(lifecycle.startRuntime).toHaveBeenCalledWith(plan);
    expect(lifecycle.updateExternalRuntime).not.toHaveBeenCalled();
  });

  it("rejects update when no update is available", async () => {
    const lifecycle = controller();
    const current = provider();
    await expect(updateAntigravityRuntime(lifecycle, current)).rejects.toThrow(
      "No reviewed Antigravity update is currently available.",
    );
  });
});
