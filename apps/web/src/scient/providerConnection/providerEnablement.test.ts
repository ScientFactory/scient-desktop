import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildEnableProviderPatch } from "./providerEnablement";

const codex = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
} satisfies Pick<ServerProvider, "driver" | "instanceId">;

describe("buildEnableProviderPatch", () => {
  it("enables an existing instance and removes a conflicting legacy flag", () => {
    const patch = buildEnableProviderPatch(
      {
        providers: DEFAULT_SERVER_SETTINGS.providers,
        providerInstances: {
          [codex.instanceId]: {
            driver: codex.driver,
            enabled: false,
            config: { enabled: false, binaryPath: "/opt/codex" },
          },
        },
      },
      codex,
    );

    expect(patch?.providerInstances?.[codex.instanceId]).toEqual({
      driver: codex.driver,
      enabled: true,
      config: { binaryPath: "/opt/codex" },
    });
  });

  it("promotes a default legacy provider without losing its configuration", () => {
    const patch = buildEnableProviderPatch(
      {
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            enabled: false,
            binaryPath: "/opt/codex",
          },
        },
        providerInstances: {},
      },
      codex,
    );

    expect(patch?.providerInstances?.[codex.instanceId]).toEqual({
      driver: codex.driver,
      enabled: true,
      config: expect.objectContaining({ binaryPath: "/opt/codex" }),
    });
    expect(patch?.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("does not invent configuration for an unknown custom instance", () => {
    expect(
      buildEnableProviderPatch(DEFAULT_SERVER_SETTINGS, {
        driver: codex.driver,
        instanceId: ProviderInstanceId.make("codex-work"),
      }),
    ).toBeNull();
  });
});
