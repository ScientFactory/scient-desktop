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
  it.each(["droid", "omp", "scient"])("retains the %s-only project writer", (driver) => {
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
});
