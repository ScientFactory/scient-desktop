import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  startCodexBrowserSignIn,
  startCodexDeviceSignIn,
  updateCodexRuntime,
} from "./codexLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("codex");
const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.147.0",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: { methods: ["codex_browser"], canDisconnect: false, operation: null },
  ...patch,
});

const updatePlan: ProviderRuntimePlan = {
  instanceId: INSTANCE_ID,
  action: "update",
  target: "darwin-arm64",
  version: "0.148.0",
  downloadBytes: 1,
  sourceLabel: "Official OpenAI release",
  catalogRevision: "reviewed:2",
  message: "Update Codex.",
};

function controller(overrides: Partial<ProviderLifecycleController> = {}) {
  return {
    startConnection: vi.fn(async () => provider()),
    cancelConnection: vi.fn(async () => provider()),
    submitAuthorizationCode: vi.fn(async () => provider()),
    disconnect: vi.fn(async () => provider()),
    openAuthorizationPage: vi.fn(async () => undefined),
    planRuntime: vi.fn(async () => updatePlan),
    startRuntime: vi.fn(async () => provider()),
    cancelRuntime: vi.fn(async () => provider()),
    updateExternalRuntime: vi.fn(async () => provider()),
    ...overrides,
  } satisfies ProviderLifecycleController;
}

describe("Codex lifecycle actions", () => {
  it("routes a managed update through the reviewed runtime plan", async () => {
    const lifecycle = controller();
    const managed = provider({
      connection: {
        methods: ["codex_browser"],
        canDisconnect: false,
        operation: null,
        runtime: {
          source: "scient_managed",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["update", "repair", "remove"],
          managedVersion: "0.147.0",
          previousManagedVersion: null,
          operation: null,
          message: "Managed Codex is ready.",
        },
      },
    });

    await updateCodexRuntime(lifecycle, managed);

    expect(lifecycle.planRuntime).toHaveBeenCalledWith("update");
    expect(lifecycle.startRuntime).toHaveBeenCalledWith(updatePlan);
    expect(lifecycle.updateExternalRuntime).not.toHaveBeenCalled();
  });

  it("preserves T3's updater for an external installation", async () => {
    const lifecycle = controller();
    await updateCodexRuntime(
      lifecycle,
      provider({
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "0.147.0",
          latestVersion: "0.148.0",
          updateCommand: "npm install -g @openai/codex@latest",
          canUpdate: true,
          checkedAt: "2026-08-09T08:00:00.000Z",
          message: "Update available.",
        },
      }),
    );

    expect(lifecycle.updateExternalRuntime).toHaveBeenCalledOnce();
    expect(lifecycle.planRuntime).not.toHaveBeenCalled();
  });

  it("opens the provider-owned browser URL returned by Codex", async () => {
    const lifecycle = controller({
      startConnection: vi.fn(async () =>
        provider({
          connection: {
            methods: ["codex_browser"],
            canDisconnect: false,
            operation: {
              operationId: "connection-1",
              method: "codex_browser",
              status: "waiting_for_browser",
              startedAt: "2026-08-09T08:00:00.000Z",
              finishedAt: null,
              message: "Finish sign in.",
              authorizationUrl: "https://auth.openai.com/",
            },
          },
        }),
      ),
    });

    await startCodexBrowserSignIn(lifecycle);

    expect(lifecycle.openAuthorizationPage).toHaveBeenCalledWith("https://auth.openai.com/");
  });

  it("starts and opens Codex's official device-code flow", async () => {
    const lifecycle = controller({
      startConnection: vi.fn(async () =>
        provider({
          connection: {
            methods: ["codex_browser", "codex_device_code"],
            canDisconnect: false,
            operation: {
              operationId: "connection-device",
              method: "codex_device_code",
              status: "waiting_for_device_code",
              startedAt: "2026-08-09T08:00:00.000Z",
              finishedAt: null,
              message: "Enter the device code.",
              authorizationUrl: "https://auth.openai.com/device",
              userCode: "ABCD-EFGH",
            },
          },
        }),
      ),
    });

    await startCodexDeviceSignIn(lifecycle);

    expect(lifecycle.startConnection).toHaveBeenCalledWith("codex_device_code");
    expect(lifecycle.openAuthorizationPage).toHaveBeenCalledWith("https://auth.openai.com/device");
  });
});
