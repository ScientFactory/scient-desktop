import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveIdleCompaction,
} from "@t3tools/contracts";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("Scient Agent idle compaction setting", () => {
  it("resolves every choice in the form to the mode it names", () => {
    const scient = providerClients.get(ProviderDriverKind.make("scient"));
    const field = deriveProviderSettingsFields(scient!).find((f) => f.key === "idleCompaction");
    const options = field?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    const instanceId = ProviderInstanceId.make("scient");
    // The environment-wide mode is "Never", so following it is distinguishable from the agent's default.
    const settings = (config: Record<string, unknown> | undefined) => ({
      ...DEFAULT_SERVER_SETTINGS,
      idleCompaction: "off" as const,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("scient"), config: config ?? {} },
      },
    });
    // What the form's select shows for a missing key.
    expect(options[0]?.value).toBe(resolveIdleCompaction(settings(undefined), instanceId));
    for (const option of options) {
      // As ProviderSettingsSelect saves a choice: the first option clears the key.
      const config = nextProviderConfigWithFieldValue(
        {},
        field!,
        option.value === options[0]?.value ? "" : option.value,
      );
      expect(resolveIdleCompaction(settings(config), instanceId), option.label).toBe(
        option.value === "default" ? "off" : option.value,
      );
    }
  });
});
