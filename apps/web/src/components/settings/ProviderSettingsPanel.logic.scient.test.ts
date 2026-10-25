import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import { hasProjectSettingsOverrides } from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderInstanceOverridePatch } from "./ProviderSettingsPanel.logic";

describe("buildProviderInstanceOverridePatch (Scient)", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");

  // regression: 087611cf4b fix(upstream): repair review boundaries and completion receipts
  // Scient sends `{}` instead of upstream's `null` entry, so assert the saved result.
  it("resets the only override back to the environment's enablement", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };

    const saved = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: buildProviderInstanceOverridePatch(
        settings,
        [projectId],
        instanceId,
        undefined,
      ),
    });

    expect(resolveProjectProviderInstanceEnabled(saved, projectId, instanceId)).toBe(false);
    expect(hasProjectSettingsOverrides(saved)).toBe(false);
  });
});
