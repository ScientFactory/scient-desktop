import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import { resolveProjectSettings } from "./projectSettings.ts";
import { fallbackScientTextGenerationModelSelection } from "./scientTextGenerationSelection.ts";

const projectId = ProjectId.make("scient-project-fallback");
const drivers = [
  "codex",
  "claudeAgent",
  "cursor",
  "droid",
  "grok",
  "muse",
  "pi",
  "opencode",
  "omp",
  "antigravity",
  "scient",
];
const disabled = Object.fromEntries(
  drivers.map((driver) => [driver, { driver: ProviderDriverKind.make(driver), enabled: false }]),
);

describe("Scient writer fallback across scopes", () => {
  it.each(["omp", "scient"])("retains the %s-only project writer", (driver) => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: disabled,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "prior",
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [driver]: { enabled: true } } },
      },
    });
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(driver);
    expect(
      resolveProjectSettings(settings, null).settings.textGenerationModelSelection.instanceId,
    ).toBe("codex");
  });

  it("prefers an intentional named account over default-on Scient with stable id order", () => {
    const instances = {
      ...disabled,
      scient: { driver: ProviderDriverKind.make("scient"), enabled: true },
      "codex-z": { driver: ProviderDriverKind.make("codex"), enabled: true },
      "codex-a": { driver: ProviderDriverKind.make("codex"), enabled: true },
    };
    const enabled = new Set(["scient", "codex-z", "codex-a"]);
    const selected = fallbackScientTextGenerationModelSelection(instances, (id) => enabled.has(id));
    expect(selected?.instanceId).toBe("codex-a");
  });

  // A backend behind a custom model may refuse the built-in default (upstream #12651).
  it("uses the thread default only when it is a custom model on the chosen instance", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const claudeWork = ProviderInstanceId.make("claude-work");
    const custom = "z-ai/glm-5.3-flash";
    const instances = {
      ...disabled,
      [claude]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [custom] },
      },
      [claudeWork]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["work-model"] },
      },
    };
    const enabled = new Set<string>([claude, claudeWork]);
    const isEnabled = (id: ProviderInstanceId) => enabled.has(id);
    const threadDefault = {
      instanceId: claude,
      model: custom,
      options: [{ id: "thinking", value: false }],
    };

    expect(
      fallbackScientTextGenerationModelSelection(instances, isEnabled, {
        defaultModelSelection: threadDefault,
      }),
    ).toEqual(threadDefault);
    // A built-in thread default keeps the cheap writer model.
    expect(
      fallbackScientTextGenerationModelSelection(instances, isEnabled, {
        defaultModelSelection: { instanceId: claude, model: "claude-fable-5-1" },
      }),
    ).toEqual({ instanceId: claude, model: "claude-haiku-5-5" });
    // Routed by instance, not driver: another Claude account's custom model is not borrowed.
    expect(
      fallbackScientTextGenerationModelSelection(instances, isEnabled, {
        defaultModelSelection: { instanceId: claudeWork, model: "work-model" },
      }),
    ).toEqual({ instanceId: claude, model: "claude-haiku-5-5" });
  });

  it("uses a project's custom thread default for its writer fallback", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const custom = "z-ai/glm-5.3-flash";
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        ...disabled,
        [claude]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: { customModels: [custom] },
        },
      },
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "prior",
      },
      projectSettingsOverrides: {
        [projectId]: {
          providerInstances: { [claude]: { enabled: true } },
          defaultModelSelection: { instanceId: claude, model: custom },
        },
      },
    });
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection,
    ).toEqual({ instanceId: claude, model: custom });
  });
});
