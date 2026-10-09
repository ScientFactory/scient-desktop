import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { fallbackTextGenerationProvider } from "./scientServerSettings.ts";

const withoutStableDefaults = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
    },
    [ProviderInstanceId.make("claudeAgent")]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: false,
    },
    [ProviderInstanceId.make("antigravity")]: {
      driver: ProviderDriverKind.make("antigravity"),
      enabled: false,
    },
  },
} satisfies ServerSettings;

describe("Scient text-generation enablement defaults", () => {
  it("does not select never-enabled Droid or OMP ahead of Scient Agent", () => {
    expect(
      fallbackTextGenerationProvider(withoutStableDefaults).textGenerationModelSelection.instanceId,
    ).toBe("scient");
  });

  it("prefers an enabled named account over untouched default-off drivers and Scient Agent", () => {
    const namedId = ProviderInstanceId.make("claude_work");
    const settings = {
      ...withoutStableDefaults,
      providerInstances: {
        ...withoutStableDefaults.providerInstances,
        [namedId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true, config: {} },
      },
    };
    expect(fallbackTextGenerationProvider(settings).textGenerationModelSelection.instanceId).toBe(
      namedId,
    );
  });

  it.each(["droid", "omp"])("chooses %s only after an explicit opt-in", (kind) => {
    const instanceId = ProviderInstanceId.make(kind);
    const driver = ProviderDriverKind.make(kind);
    const settings = {
      ...withoutStableDefaults,
      providerInstances: {
        ...withoutStableDefaults.providerInstances,
        [instanceId]: { driver, config: {} },
      },
    };
    expect(fallbackTextGenerationProvider(settings).textGenerationModelSelection.instanceId).toBe(
      "scient",
    );
    expect(
      fallbackTextGenerationProvider({
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: { driver, enabled: true },
        },
      }).textGenerationModelSelection.instanceId,
    ).toBe(instanceId);
  });

  it("does not restore an explicitly disabled Scient Agent", () => {
    const settings = {
      ...withoutStableDefaults,
      providerInstances: {
        ...withoutStableDefaults.providerInstances,
        [ProviderInstanceId.make("scient")]: {
          driver: ProviderDriverKind.make("scient"),
          enabled: false,
        },
      },
    };
    expect(fallbackTextGenerationProvider(settings)).toBe(settings);
  });
});
