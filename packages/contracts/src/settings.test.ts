import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ComputeLanguageId } from "@scientfactory/compute";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { AuthProvidersManageScope, AuthSettingsWriteScope } from "./auth.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  CodexSettings,
  AntigravitySettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  resolveScientificComputingLanguageSettings,
  requiredScopesForProjectMutation,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  isUnconfiguredDefaultInstanceEnabled,
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
  OmpSettings,
  DroidSettings,
  ScientAgentSettings,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

// SCIENT-FORK:START
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
// SCIENT-FORK:END

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      // Scient keeps any local file by default; upstream keeps only uncommitted changes.
      worktreeKeepWhen: "any-local-files",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      // Scient keeps any local file by default.
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "any-local-files" },
    });
  });

  it("rejects unknown local-file retention policies", () => {
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
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

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
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

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("accepts custom model entries for OMP instances", () => {
    const decodeOmpSettings = Schema.decodeUnknownSync(OmpSettings);
    expect(
      decodeOmpSettings({ customModels: [{ slug: "local", name: "Local", capabilities }] })
        .customModels,
    ).toEqual([{ slug: "local", name: "Local", capabilities }]);
    expect(decodeOmpSettings({}).customModels).toEqual([]);
  });
});

describe("ClientSettings typography defaults", () => {
  it("defaults old settings to regular weight without adding a patch value", () => {
    expect(decodeClientSettings({}).fontWeightInterface).toBe(400);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("fontWeightInterface");
  });

  it.each([300, 400, 500])("preserves interface weight %s", (fontWeightInterface) => {
    expect(decodeClientSettings({ fontWeightInterface }).fontWeightInterface).toBe(
      fontWeightInterface,
    );
    expect(decodeClientSettingsPatch({ fontWeightInterface }).fontWeightInterface).toBe(
      fontWeightInterface,
    );
  });

  it.each([0, 299, 350, 501, 700, 900, 400.5, "400", "bold", null, Number.NaN, Infinity])(
    "rejects unsupported interface weight %s at both boundaries",
    (fontWeightInterface) => {
      expect(() => decodeClientSettings({ fontWeightInterface })).toThrow();
      expect(() => decodeClientSettingsPatch({ fontWeightInterface })).toThrow();
    },
  );
  it("uses the Scient comfortable-reading profile", () => {
    expect(DEFAULT_CLIENT_SETTINGS).toMatchObject({
      fontSizeInterface: 17,
      fontSizePrompt: 16,
      fontSizeCode: 15,
      fontSizeTerminal: 14,
    });
  });

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

  it.each([true, false])("preserves the explicit preference %s", (showSkillsInSlashMenu) => {
    expect(decodeClientSettings({ showSkillsInSlashMenu }).showSkillsInSlashMenu).toBe(
      showSkillsInSlashMenu,
    );
    expect(decodeClientSettingsPatch({ showSkillsInSlashMenu }).showSkillsInSlashMenu).toBe(
      showSkillsInSlashMenu,
    );
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
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

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings browser link target", () => {
  it("keeps links in Scient by default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.browserLinkTarget).toBe("app");
    expect(decodeClientSettings({}).browserLinkTarget).toBe("app");
  });

  it.each(["app", "system"] as const)("preserves an explicit %s preference", (target) => {
    expect(decodeClientSettings({ browserLinkTarget: target }).browserLinkTarget).toBe(target);
    expect(decodeClientSettingsPatch({ browserLinkTarget: target }).browserLinkTarget).toBe(target);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to 120% contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(120);
  });

  it("preserves the previous default when it was explicitly persisted", () => {
    expect(decodeClientSettings({ appearanceContrast: 100 }).appearanceContrast).toBe(100);
    expect(decodeClientSettingsPatch({ appearanceContrast: 100 }).appearanceContrast).toBe(100);
  });
});

describe("ClientSettings content direction", () => {
  it("defaults conversational prose to automatic direction", () => {
    expect(decodeClientSettings({}).contentDirection).toBe("auto");
  });

  it.each(["auto", "rtl", "ltr"] as const)("accepts %s", (contentDirection) => {
    expect(decodeClientSettings({ contentDirection }).contentDirection).toBe(contentDirection);
    expect(decodeClientSettingsPatch({ contentDirection }).contentDirection).toBe(contentDirection);
  });

  it("rejects unsupported content directions", () => {
    expect(() => decodeClientSettings({ contentDirection: "vertical" })).toThrow();
    expect(() => decodeClientSettingsPatch({ contentDirection: "vertical" })).toThrow();
  });
});

describe("ClientSettings composer collapse", () => {
  it("defaults to Never for missing settings and shared reset defaults", () => {
    for (const defaults of [
      decodeClientSettings({}),
      DEFAULT_CLIENT_SETTINGS,
      DEFAULT_UNIFIED_SETTINGS,
    ]) {
      expect(defaults.composerCollapseOnScroll).toBe(false);
      expect(defaults).not.toHaveProperty("composerCollapseOnBlur");
    }
  });

  it.each([true, false])("preserves a saved scroll choice of %s", (composerCollapseOnScroll) => {
    expect(
      decodeClientSettings(encodeClientSettings(decodeClientSettings({ composerCollapseOnScroll })))
        .composerCollapseOnScroll,
    ).toBe(composerCollapseOnScroll);
    expect(decodeClientSettingsPatch({ composerCollapseOnScroll }).composerCollapseOnScroll).toBe(
      composerCollapseOnScroll,
    );
  });

  it("drops the retired blur trigger key", () => {
    const decoded = decodeClientSettings({ composerCollapseOnBlur: true });
    expect(decoded.composerCollapseOnScroll).toBe(false);
    expect(decoded).not.toHaveProperty("composerCollapseOnBlur");
  });
});

describe("ServerSettings thread settlement", () => {
  it("keeps Scient's conservative automatic settlement defaults", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(7);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
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

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(isUnconfiguredDefaultInstanceEnabled(ProviderInstanceId.make("ollama"))).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });

  it("enables agent browser access for legacy configs", () => {
    expect(decodeServerSettings({}).enableAgentBrowserAccess).toBe(true);
  });

  it("preserves an explicit agent browser access opt-out", () => {
    expect(decodeServerSettings({ enableAgentBrowserAccess: false }).enableAgentBrowserAccess).toBe(
      false,
    );
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
describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings provider instance config", () => {
  it("preserves Scient driver configuration in the aligned instance map", () => {
    const droidId = ProviderInstanceId.make("droid");
    const config = Schema.decodeUnknownSync(DroidSettings)({ cloudSessionSync: false });
    const decoded = decodeServerSettings({
      providerInstances: {
        [droidId]: { driver: ProviderDriverKind.make("droid"), enabled: true, config },
      },
    });
    expect(decoded.providerInstances[droidId]?.config).toEqual(config);
    expect(
      Schema.decodeUnknownSync(DroidSettings)(decoded.providerInstances[droidId]?.config),
    ).toMatchObject({ cloudSessionSync: false });
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
    expect(() => Schema.encodeSync(ServerSettingsPatch)(patch)).toThrow(
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

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
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

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
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
