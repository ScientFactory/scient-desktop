import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ComputeLanguageId } from "@scientfactory/compute";

import { AuthProvidersManageScope, AuthSettingsWriteScope } from "./auth.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  AntigravitySettings,
  ClaudeSettings,
  ClientSettingsPatch,
  ClientSettingsSchema,
  CodexSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DroidSettings,
  isUnconfiguredDefaultInstanceEnabled,
  OmpSettings,
  requiredScopesForServerSettingsPatch,
  resolveProviderInstanceEnabled,
  resolveScientificComputingLanguageSettings,
  ScientAgentSettings,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

// Scient settings contracts, kept beside upstream's settings.test.ts.
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeDroidSettings = Schema.decodeUnknownSync(DroidSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);

describe("ServerSettings thread sections", () => {
  it("defaults to an empty catalog with General first, and round-trips a layout", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.threadSections).toEqual([]);
    expect(decoded.threadSectionsGeneralIndex).toBe(0);
    expect(decoded.threadSectionsDeleteEmptyAfterDays).toBeNull();
    const input = {
      threadSections: [
        { id: "research", name: "Research", order: 0 },
        { id: "perma", name: "Perma", order: 1 },
      ],
      threadSectionsGeneralIndex: 1,
      threadSectionsDeleteEmptyAfterDays: 7,
    };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });

  it("leaves the layout alone when a patch omits it", () => {
    expect(decodeServerSettingsPatch({})).toEqual({});
  });
});

describe("ServerSettings Cursor account usage", () => {
  // Reading another app's Keychain login makes macOS ask for a password, so it
  // stays off until the user turns it on; never at launch by default.
  it("keeps Keychain usage off until enabled, preserving an explicit opt-in", () => {
    expect(decodeServerSettings({}).cursorKeychainUsageEnabled).toBe(false);
    expect(DEFAULT_SERVER_SETTINGS.cursorKeychainUsageEnabled).toBe(false);
    expect(
      decodeServerSettings({ cursorKeychainUsageEnabled: true }).cursorKeychainUsageEnabled,
    ).toBe(true);
    expect(decodeServerSettingsPatch({ cursorKeychainUsageEnabled: true })).toEqual({
      cursorKeychainUsageEnabled: true,
    });
  });
});

describe("ClientSettings typography defaults", () => {
  it("defaults old settings to regular weight without adding a patch value", () => {
    expect(decodeClientSettings({}).fontWeightInterface).toBe(400);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("fontWeightInterface");
  });

  // regression: 07dfb38be0 feat(web): add interface text weight preference
  it.each([300, 400, 500])("preserves interface weight %s", (fontWeightInterface) => {
    expect(decodeClientSettings({ fontWeightInterface }).fontWeightInterface).toBe(
      fontWeightInterface,
    );
    expect(decodeClientSettingsPatch({ fontWeightInterface }).fontWeightInterface).toBe(
      fontWeightInterface,
    );
  });

  // regression: 07dfb38be0 feat(web): add interface text weight preference
  it.each([0, 299, 350, 501, 700, 900, 400.5, "400", "bold", null, Number.NaN, Infinity])(
    "rejects unsupported interface weight %s at both boundaries",
    (fontWeightInterface) => {
      expect(() => decodeClientSettings({ fontWeightInterface })).toThrow();
      expect(() => decodeClientSettingsPatch({ fontWeightInterface })).toThrow();
    },
  );

  it("preserves an explicitly chosen interface size", () => {
    expect(decodeClientSettings({ fontSizeInterface: 18 }).fontSizeInterface).toBe(18);
    expect(decodeClientSettingsPatch({ fontSizeInterface: 18 }).fontSizeInterface).toBe(18);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("fontSizeInterface");
  });
});

describe("ClientSettings slash-menu skills", () => {
  it("defaults skill aliases off without removing the preference", () => {
    expect(DEFAULT_CLIENT_SETTINGS.showSkillsInSlashMenu).toBe(false);
    expect(decodeClientSettings({}).showSkillsInSlashMenu).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("showSkillsInSlashMenu");
  });

  // regression: 8ad1596483 fix(defaults): use 17px interface and opt-in slash skill aliases
  it.each([true, false])("preserves the explicit preference %s", (showSkillsInSlashMenu) => {
    expect(decodeClientSettings({ showSkillsInSlashMenu }).showSkillsInSlashMenu).toBe(
      showSkillsInSlashMenu,
    );
    expect(decodeClientSettingsPatch({ showSkillsInSlashMenu }).showSkillsInSlashMenu).toBe(
      showSkillsInSlashMenu,
    );
  });
});

describe("ClientSettings voice transcript correction", () => {
  it("defaults off and accepts an explicit opt-in", () => {
    expect(decodeClientSettings({}).voiceTranscriptCorrectionEnabled).toBe(false);
    expect(
      decodeClientSettingsPatch({ voiceTranscriptCorrectionEnabled: true })
        .voiceTranscriptCorrectionEnabled,
    ).toBe(true);
  });
});

describe("ClientSettings voice language", () => {
  it("defaults to automatic detection and accepts supported preferences", () => {
    expect(decodeClientSettings({}).voiceLanguagePreference).toBe("auto");
    expect(
      decodeClientSettingsPatch({ voiceLanguagePreference: "he" }).voiceLanguagePreference,
    ).toBe("he");
  });

  it("rejects unsupported language values", () => {
    expect(() => decodeClientSettings({ voiceLanguagePreference: "xx" })).toThrow();
    expect(() => decodeClientSettingsPatch({ voiceLanguagePreference: "xx" })).toThrow();
  });
});

describe("ClientSettings browser link target", () => {
  it("keeps links in Scient by default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.browserLinkTarget).toBe("app");
    expect(decodeClientSettings({}).browserLinkTarget).toBe("app");
  });

  // regression: 93022cea02 Sync T3 upstream through 223ff449 (#249)
  it.each(["app", "system"] as const)("preserves an explicit %s preference", (target) => {
    expect(decodeClientSettings({ browserLinkTarget: target }).browserLinkTarget).toBe(target);
    expect(decodeClientSettingsPatch({ browserLinkTarget: target }).browserLinkTarget).toBe(target);
  });
});

describe("ClientSettings content direction", () => {
  it("defaults conversational prose to automatic direction", () => {
    expect(decodeClientSettings({}).contentDirection).toBe("auto");
  });

  // regression: 86037f6f57 feat(web): add robust conversational RTL direction (#15)
  it.each(["auto", "rtl", "ltr"] as const)("accepts %s", (contentDirection) => {
    expect(decodeClientSettings({ contentDirection }).contentDirection).toBe(contentDirection);
    expect(decodeClientSettingsPatch({ contentDirection }).contentDirection).toBe(contentDirection);
  });

  it("rejects unsupported content directions", () => {
    expect(() => decodeClientSettings({ contentDirection: "vertical" })).toThrow();
    expect(() => decodeClientSettingsPatch({ contentDirection: "vertical" })).toThrow();
  });
});

describe("ServerSettings thread settlement", () => {
  it("keeps Scient's conservative automatic settlement defaults", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(7);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});

describe("ServerSettings scientific computing", () => {
  it("enables every language by default while preserving explicit opt-outs", () => {
    const python = ComputeLanguageId.make("python");
    const matlab = ComputeLanguageId.make("matlab");
    const futureLanguage = ComputeLanguageId.make("future-language");
    expect(decodeServerSettings({}).scientificComputing).toEqual({
      schemaVersion: 1,
      languages: {},
    });
    expect(DEFAULT_SERVER_SETTINGS.scientificComputing.languages).toEqual({});
    expect(
      resolveScientificComputingLanguageSettings(
        DEFAULT_SERVER_SETTINGS.scientificComputing,
        python,
      ),
    ).toEqual({ enabled: true, executable: "" });
    expect(
      resolveScientificComputingLanguageSettings(
        DEFAULT_SERVER_SETTINGS.scientificComputing,
        matlab,
      ),
    ).toEqual({ enabled: true, executable: "" });
    expect(
      resolveScientificComputingLanguageSettings(
        DEFAULT_SERVER_SETTINGS.scientificComputing,
        futureLanguage,
      ),
    ).toEqual({ enabled: true, executable: "" });
    const disabled = decodeServerSettings({
      scientificComputing: { languages: { python: { enabled: false } } },
    });
    expect(
      resolveScientificComputingLanguageSettings(disabled.scientificComputing, python),
    ).toEqual({ enabled: false, executable: "" });
  });

  it("round-trips independent language preferences without installation state", () => {
    const settings = decodeServerSettings({
      scientificComputing: {
        schemaVersion: 1,
        languages: {
          python: { enabled: true, executable: " /opt/python/bin/python3 " },
          r: { enabled: false, executable: "" },
        },
      },
    });
    expect(settings.scientificComputing.languages).toEqual({
      python: { enabled: true, executable: "/opt/python/bin/python3" },
      r: { enabled: false, executable: "" },
    });
    expect(encodeServerSettings(settings).scientificComputing).toEqual(
      settings.scientificComputing,
    );
  });

  it("accepts a narrow per-language patch", () => {
    expect(
      decodeServerSettingsPatch({
        scientificComputing: {
          languages: { python: { enabled: true } },
        },
      }).scientificComputing,
    ).toEqual({ languages: { python: { enabled: true } } });
  });
});

describe("ServerSettings provider instance config", () => {
  it("preserves Scient driver configuration in the aligned instance map", () => {
    const droidId = ProviderInstanceId.make("droid");
    const config = decodeDroidSettings({ cloudSessionSync: false });
    const decoded = decodeServerSettings({
      providerInstances: {
        [droidId]: { driver: ProviderDriverKind.make("droid"), enabled: true, config },
      },
    });
    expect(decoded.providerInstances[droidId]?.config).toEqual(config);
    expect(decodeDroidSettings(decoded.providerInstances[droidId]?.config)).toMatchObject({
      cloudSessionSync: false,
    });
  });

  it("preserves the full instance map in a patch", () => {
    const droidId = ProviderInstanceId.make("droid");
    const config = { binaryPath: "droid", cloudSessionSync: false };
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        [droidId]: { driver: ProviderDriverKind.make("droid"), config },
      },
    });
    expect(patch.providerInstances?.[droidId]?.config).toEqual(config);
  });
});

describe("ServerSettingsPatch legacy provider compatibility", () => {
  it("decodes the old providers map for server translation but never re-encodes it", () => {
    const patch = decodeServerSettingsPatch({
      providers: { codex: { binaryPath: "/legacy/codex", opaque: { revision: 2 } } },
    });
    expect(patch.providers).toEqual({
      codex: { binaryPath: "/legacy/codex", opaque: { revision: 2 } },
    });
    expect(() => encodeServerSettingsPatch(patch)).toThrow(
      "The legacy providers patch is accepted from older clients only.",
    );
  });

  it("requires provider management scope for legacy provider patches", () => {
    const patch = decodeServerSettingsPatch({ providers: { codex: { enabled: false } } });
    expect(requiredScopesForServerSettingsPatch(patch)).toEqual([AuthProvidersManageScope]);

    const mixedPatch = decodeServerSettingsPatch({
      providers: { codex: { enabled: false } },
      responseStreamingMode: "turn",
    });
    expect(requiredScopesForServerSettingsPatch(mixedPatch)).toEqual([
      AuthSettingsWriteScope,
      AuthProvidersManageScope,
    ]);
  });
});

describe("branch naming settings", () => {
  it("defaults existing settings to the scient static prefix", () => {
    expect(decodeServerSettings({})).toMatchObject({
      branchNamingMode: "static",
      branchNamePrefix: "scient",
      branchNameInstructions: "",
    });
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };
  it("accepts custom model entries for OMP instances", () => {
    const decodeOmpSettings = Schema.decodeUnknownSync(OmpSettings);
    expect(
      decodeOmpSettings({ customModels: [{ slug: "local", name: "Local", capabilities }] })
        .customModels,
    ).toEqual([{ slug: "local", name: "Local", capabilities }]);
    expect(decodeOmpSettings({}).customModels).toEqual([]);
  });
});

describe("provider enabled defaults", () => {
  it("preserves stable and Scient-specific enabled defaults", () => {
    const enabledByDefault = (driver: string) =>
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make(driver), config: {} });
    expect(enabledByDefault("codex")).toBe(true);
    expect(enabledByDefault("claudeAgent")).toBe(true);
    expect(enabledByDefault("scient")).toBe(true);
    expect(enabledByDefault("antigravity")).toBe(true);
    for (const driver of ["cursor", "droid", "omp", "grok", "muse", "pi", "opencode"]) {
      expect(enabledByDefault(driver)).toBe(false);
    }
  });
  it.each([
    ["codex", CodexSettings],
    ["claudeAgent", ClaudeSettings],
    ["antigravity", AntigravitySettings],
    ["droid", DroidSettings],
    ["omp", OmpSettings],
    ["scient", ScientAgentSettings],
  ] as const)("keeps %s eligibility consistent with its config schema", (driver, schema) => {
    const enabled = Schema.decodeSync(schema)({}).enabled;
    expect(resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make(driver) })).toBe(
      enabled,
    );
    expect(isUnconfiguredDefaultInstanceEnabled(ProviderInstanceId.make(driver))).toBe(enabled);
  });
  // regression: 89974f96b6 fix(alignment): preserve Scient provider and lifecycle behavior
  it.each(["droid", "omp", "scient", "antigravity"])(
    "preserves explicit %s enablement and disables",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      expect(resolveProviderInstanceEnabled({ driver, enabled: true })).toBe(true);
      expect(resolveProviderInstanceEnabled({ driver, enabled: false })).toBe(false);
      expect(resolveProviderInstanceEnabled({ driver, config: { enabled: true } })).toBe(true);
      expect(
        resolveProviderInstanceEnabled({ driver, enabled: true, config: { enabled: false } }),
      ).toBe(false);
      expect(
        resolveProviderInstanceEnabled({ driver, enabled: false, config: { enabled: true } }),
      ).toBe(false);
      expect(isUnconfiguredDefaultInstanceEnabled(ProviderInstanceId.make(`${kind}_work`))).toBe(
        false,
      );
    },
  );

  it("does not enable an unconfigured plugin instance by default", () => {
    expect(isUnconfiguredDefaultInstanceEnabled(ProviderInstanceId.make("ollama"))).toBe(false);
  });
});

describe("ServerSettings agent browser access", () => {
  it("enables agent browser access for legacy configs", () => {
    expect(decodeServerSettings({}).enableAgentBrowserAccess).toBe(true);
  });
  it("preserves an explicit agent browser access opt-out", () => {
    expect(decodeServerSettings({ enableAgentBrowserAccess: false }).enableAgentBrowserAccess).toBe(
      false,
    );
  });
});

it("keeps per-instance initialization snapshots on visibility and order wire commands", () => {
  const initialPreferences = { hiddenModels: ["previous-hidden"], modelOrder: ["preferred"] };
  const patch = {
    setModelsHidden: [
      { provider: "scient-personal", model: "new-hidden", hidden: true, initialPreferences },
    ],
    setProviderModelOrder: { provider: "scient-personal", modelOrder: [], initialPreferences },
  };
  expect(decodeServerSettingsPatch(patch)).toEqual(patch);
});
