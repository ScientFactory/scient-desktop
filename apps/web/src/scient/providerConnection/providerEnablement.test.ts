import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildEnableProviderPatch, withProviderInstanceEnabled } from "./providerEnablement";

const codex = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
} satisfies Pick<ServerProvider, "driver" | "instanceId">;

describe("buildEnableProviderPatch", () => {
  it("normalizes the direct Settings enable action", () => {
    expect(
      withProviderInstanceEnabled(
        {
          driver: codex.driver,
          enabled: false,
          config: { enabled: false, binaryPath: "/opt/codex" },
        },
        true,
      ),
    ).toEqual({
      driver: codex.driver,
      enabled: true,
      config: { binaryPath: "/opt/codex" },
    });
  });

  it("enables an existing instance and removes a conflicting legacy flag", () => {
    const patch = buildEnableProviderPatch(
      {
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

  it("enables an unconfigured default instance through the instance envelope", () => {
    const patch = buildEnableProviderPatch(DEFAULT_SERVER_SETTINGS, codex);

    expect(patch?.providerInstances?.[codex.instanceId]).toEqual({
      driver: codex.driver,
      enabled: true,
    });
    expect(patch).not.toHaveProperty("providers");
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
