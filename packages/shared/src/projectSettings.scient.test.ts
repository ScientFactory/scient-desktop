import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const decodeSettingsPatch = Schema.decodeSync(ServerSettingsPatch);

describe("projectSettingsOverrides patches", () => {
  it.each(["Keep scientific terminology.", ""])(
    "preserves project title instructions %j when an older client edits another setting",
    (threadTitleInstructions) => {
      const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        threadTitleInstructions: "Use the environment's title convention.",
        projectSettingsOverrides: {
          [projectId]: { threadTitleInstructions, defaultAutoPull: true },
        },
      });
      const patch = decodeSettingsPatch({
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: false } },
      });
      const saved = applyServerSettingsPatch(current, patch);
      const resolved = resolveProjectSettings(saved, projectId);

      expect(resolved.settings.threadTitleInstructions).toBe(threadTitleInstructions);
      expect(resolved.sources.threadTitleInstructions).toBe("project");
      expect(resolved.settings.defaultAutoPull).toBe(false);
    },
  );

  it("restores inherited title instructions without clearing another project override", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadTitleInstructions: "Use the environment's title convention.",
      projectSettingsOverrides: {
        [projectId]: { threadTitleInstructions: "Use project terminology.", defaultAutoPull: true },
      },
    });
    const patch = decodeSettingsPatch(
      JSON.parse(
        JSON.stringify({
          projectSettingsOverrides: {
            [projectId]: clearProjectSettingsOverrides(current, projectId, [
              "threadTitleInstructions",
            ]),
          },
        }),
      ),
    );
    const saved = applyServerSettingsPatch(current, patch);
    const resolved = resolveProjectSettings(saved, projectId);

    expect(resolved.settings.threadTitleInstructions).toBe(current.threadTitleInstructions);
    expect(resolved.sources.threadTitleInstructions).toBe("environment");
    expect(saved.projectSettingsOverrides[projectId]).toEqual({ defaultAutoPull: true });
  });

  it.each(["Keep scientific terminology.", ""])(
    "keeps title instructions %j but clears instance overrides when an older client resets the project",
    (threadTitleInstructions) => {
      const instanceId = ProviderInstanceId.make("codex_work");
      const current = applyServerSettingsPatch(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
          },
        },
        {
          threadTitleInstructions: "Use the environment's title convention.",
          projectSettingsOverrides: {
            [projectId]: {
              threadTitleInstructions,
              defaultAutoPull: true,
              providerInstances: { [instanceId]: { enabled: true } },
            },
          },
        },
      );
      const patch = decodeSettingsPatch({
        projectSettingsOverrides: { [projectId]: null },
      });
      const saved = applyServerSettingsPatch(current, patch);
      const resolved = resolveProjectSettings(saved, projectId);

      expect(resolved.settings.threadTitleInstructions).toBe(threadTitleInstructions);
      expect(resolved.sources.threadTitleInstructions).toBe("project");
      expect(resolved.sources.defaultAutoPull).toBe("environment");
      expect(resolveProjectProviderInstanceEnabled(saved, projectId, instanceId)).toBe(false);
    },
  );

  it("clears a project's only instance override when an older client resets it with null", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const current = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
      },
      {
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      },
    );
    const patch = decodeSettingsPatch({
      projectSettingsOverrides: { [projectId]: null },
    });
    const saved = applyServerSettingsPatch(current, patch);

    expect(resolveProjectProviderInstanceEnabled(saved, projectId, instanceId)).toBe(false);
    expect(hasProjectSettingsOverrides(saved)).toBe(false);
  });

  it("restores inherited title instructions when they are the project's last override", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadTitleInstructions: "Use the environment's title convention.",
      projectSettingsOverrides: { [projectId]: { threadTitleInstructions: "" } },
    });
    const patch = decodeSettingsPatch(
      JSON.parse(
        JSON.stringify({
          projectSettingsOverrides: {
            [projectId]: clearProjectSettingsOverrides(current, projectId, [
              "threadTitleInstructions",
            ]),
          },
        }),
      ),
    );
    const saved = applyServerSettingsPatch(current, patch);

    expect(resolveProjectSettings(saved, projectId).sources.threadTitleInstructions).toBe(
      "environment",
    );
    expect(hasProjectSettingsOverrides(saved)).toBe(false);
  });
});
