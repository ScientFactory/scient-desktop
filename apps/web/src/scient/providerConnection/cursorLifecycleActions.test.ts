import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  startCursorBrowserSignIn,
  startReviewedCursorRuntimeAction,
} from "./cursorLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const provider = {
  instanceId: ProviderInstanceId.make("cursor"),
  driver: ProviderDriverKind.make("cursor"),
  enabled: true,
  installed: true,
  version: "2026.08.11-e8db854",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["cursor_browser"],
    canDisconnect: false,
    operation: {
      operationId: "cursor-login",
      method: "cursor_browser",
      status: "waiting_for_browser",
      startedAt: "2026-08-23T08:00:00.000Z",
      finishedAt: null,
      message: "Finish sign in.",
      authorizationUrl: "https://cursor.com/loginDeepControl",
      authorizationUrlKind: "primary",
    },
  },
} satisfies ServerProvider;

function controller(): ProviderLifecycleController {
  return {
    startConnection: vi.fn(async () => provider),
    cancelConnection: vi.fn(async () => provider),
    submitAuthorizationCode: vi.fn(async () => provider),
    disconnect: vi.fn(async () => provider),
    openAuthorizationPage: vi.fn(async () => undefined),
    planRuntime: vi.fn(async (action) => ({
      instanceId: provider.instanceId,
      action,
      target: "darwin-arm64",
      version: provider.version,
      downloadBytes: 1,
      sourceLabel: "Official Cursor Agent release",
      catalogRevision: "reviewed:cursor",
      message: "Cursor runtime action.",
    })),
    startRuntime: vi.fn(async () => provider),
    cancelRuntime: vi.fn(async () => provider),
    updateExternalRuntime: vi.fn(async () => provider),
  };
}

describe("cursorLifecycleActions", () => {
  it("opens the server-validated authorization URL after starting browser sign-in", async () => {
    const lifecycle = controller();

    await startCursorBrowserSignIn(lifecycle);

    expect(lifecycle.startConnection).toHaveBeenCalledWith("cursor_browser");
    expect(lifecycle.openAuthorizationPage).toHaveBeenCalledWith(
      "https://cursor.com/loginDeepControl",
    );
  });

  it("executes only the reviewed runtime plan returned by the server", async () => {
    const lifecycle = controller();

    await startReviewedCursorRuntimeAction(lifecycle, "repair");

    expect(lifecycle.planRuntime).toHaveBeenCalledWith("repair");
    expect(lifecycle.startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repair", catalogRevision: "reviewed:cursor" }),
    );
  });
});
