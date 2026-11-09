import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { startClaudeSignIn } from "./claudeLifecycleActions";
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
  connection: { methods: ["claude_subscription"], canDisconnect: false, operation: null },
  ...patch,
});

const updatePlan: ProviderRuntimePlan = {
  instanceId: INSTANCE_ID,
  action: "update",
  target: "darwin-arm64",
  version: "2.1.171",
  downloadBytes: 1,
  sourceLabel: "Official Anthropic release",
  catalogRevision: "reviewed:2",
  message: "Update Claude.",
};

function controller(overrides: Partial<ProviderLifecycleController> = {}) {
  return {
    startConnection: vi.fn(async () => provider()),
    cancelConnection: vi.fn(async () => provider()),
    submitAuthorizationCode: vi.fn(async () => provider()),
    disconnect: vi.fn(async () => provider()),
    signInKey: {
      environmentId: "environment-test",
      instanceId: "sign-in-test",
    } as ProviderLifecycleController["signInKey"],
    openAuthorizationPage: vi.fn(async () => undefined),
    planRuntime: vi.fn(async () => updatePlan),
    startRuntime: vi.fn(async () => provider()),
    cancelRuntime: vi.fn(async () => provider()),
    updateExternalRuntime: vi.fn(async () => provider()),
    refresh: vi.fn(async () => provider()),
    ...overrides,
  } satisfies ProviderLifecycleController;
}

describe("Claude lifecycle actions", () => {
  it("lets Claude own the first browser launch and retains Scient's reopen recovery", async () => {
    const lifecycle = controller({
      startConnection: vi.fn(async () =>
        provider({
          connection: {
            methods: ["claude_subscription", "claude_console"],
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
      ),
    });

    await startClaudeSignIn(lifecycle, "claude_subscription");

    expect(lifecycle.startConnection).toHaveBeenCalledWith("claude_subscription");
    expect(lifecycle.openAuthorizationPage).not.toHaveBeenCalled();
  });

  it("can start the Console flow without changing the provider execution path", async () => {
    const lifecycle = controller();

    await startClaudeSignIn(lifecycle, "claude_console");

    expect(lifecycle.startConnection).toHaveBeenCalledWith("claude_console");
  });
});
