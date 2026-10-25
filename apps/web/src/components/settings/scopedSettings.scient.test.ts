import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ProjectSettingsOverrides,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planScopedSettingsPatch } from "./scopedSettings";

// regression: 67ab5e432f fix(settings): keep the default model's reasoning effort as chosen (#394)
describe("model selection patches at project scope", () => {
  const environmentId = EnvironmentId.make("laptop");
  const projectId = ProjectId.make("fleet");
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const projectScope = {
    kind: "project" as const,
    group: {} as never,
    environmentId: null,
    label: "fleet",
    members: [
      {
        id: projectId,
        environmentId,
        physicalProjectKey: "laptop:/repo",
        environmentLabel: "Laptop",
        title: "fleet",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as never,
    ],
    environmentIds: [environmentId],
  };
  const planWith = (overrides: ProjectSettingsOverrides, patch: object) =>
    planScopedSettingsPatch(
      projectScope,
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              projectSettingsOverrides: { [projectId]: overrides },
            },
            environment: { capabilities: { projectSettingsOverrides: true } },
          },
        },
      ],
      patch,
    ).serverWrites[0]?.patch.projectSettingsOverrides?.[projectId];

  it("drops the previous model's options when the default model changes", () => {
    const entry = planWith(
      {
        defaultModelSelection: {
          instanceId: codex,
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
      },
      { defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" } },
    );
    expect(entry?.defaultModelSelection).toEqual({ instanceId: claude, model: "claude-opus-4-8" });
  });

  it("stores a changed effort as the whole selection", () => {
    const entry = planWith(
      {
        defaultModelSelection: {
          instanceId: codex,
          model: "gpt-5.6",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
      {
        defaultModelSelection: {
          instanceId: codex,
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      },
    );
    expect(entry?.defaultModelSelection).toEqual({
      instanceId: codex,
      model: "gpt-5.6",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("replaces the writer model the same way", () => {
    const entry = planWith(
      {
        sourceControlWriterModelSelection: {
          instanceId: codex,
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
      { sourceControlWriterModelSelection: { instanceId: claude, model: "claude-opus-4-8" } },
    );
    expect(entry?.sourceControlWriterModelSelection).toEqual({
      instanceId: claude,
      model: "claude-opus-4-8",
    });
  });

  it("still completes an options-only text generation patch from the saved value", () => {
    const entry = planWith(
      {
        textGenerationModelSelection: {
          instanceId: codex,
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
      { textGenerationModelSelection: { options: [{ id: "reasoningEffort", value: "low" }] } },
    );
    expect(entry?.textGenerationModelSelection).toEqual({
      instanceId: codex,
      model: "gpt-5.6",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
});
