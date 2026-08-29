import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("local");
const updateSettings = vi.hoisted(() => vi.fn());
const primarySession = vi.hoisted(() => ({
  data: { authenticated: true, scopes: ["orchestration:operate"] },
  error: null as string | null,
  isPending: false,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => primarySession,
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      codex: {
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        config: { enabled: false, binaryPath: "/opt/codex" },
      },
    },
  }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: false }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => updateSettings,
}));

import { useProviderEnableAction } from "./useProviderEnableAction";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: false,
  installed: true,
  version: "0.147.0",
  status: "disabled",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-24T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("useProviderEnableAction", () => {
  beforeEach(() => {
    updateSettings.mockReset().mockResolvedValue({
      _tag: "Success",
      value: DEFAULT_SERVER_SETTINGS,
    });
    primarySession.data = {
      authenticated: true,
      scopes: ["orchestration:operate"],
    };
  });

  it("performs one settings write and no provider lifecycle action", async () => {
    const action = useProviderEnableAction({ environmentId, provider });

    expect(action.canEnable).toBe(true);
    await action.enable();

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({
      environmentId,
      input: {
        patch: expect.objectContaining({
          providerInstances: expect.objectContaining({
            codex: expect.objectContaining({ enabled: true }),
          }),
        }),
      },
    });
  });

  it("does not dispatch when the session lacks operate access", async () => {
    primarySession.data = { authenticated: true, scopes: [] };
    const action = useProviderEnableAction({ environmentId, provider });

    expect(action.canEnable).toBe(false);
    await expect(action.enable()).rejects.toThrow("cannot enable Codex");
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
