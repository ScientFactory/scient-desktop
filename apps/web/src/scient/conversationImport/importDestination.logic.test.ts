import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { resolveAntigravityDraftSelection } from "../providerConnection/antigravityDraftSelection";

import { defaultImportProject, newChatModelSelection } from "./importDestination.logic";

function testProvider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string; isDefault?: boolean }>,
  status: ServerProvider["status"] = "ready",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

function testConfig(
  providers: ReadonlyArray<ServerProvider>,
  settings: Partial<ServerConfig["settings"]> = {},
): ServerConfig {
  return {
    providers,
    settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
  } as unknown as ServerConfig;
}

const codex = testProvider("codex", "codex", [
  { slug: "gpt-5", name: "GPT-5", isDefault: true },
  { slug: "gpt-5-mini", name: "GPT-5 mini" },
]);
const claude = testProvider("claudeAgent", "claudeAgent", [
  { slug: "claude-opus", name: "Claude Opus", isDefault: true },
]);
const project = { id: ProjectId.make("project-1") };

describe("newChatModelSelection", () => {
  // A new chat reads the environment's settings merged with this client's.
  const noSticky = { modelSelectionByProvider: {}, activeProvider: null };
  const modelFor = (
    config: ServerConfig,
    target: Parameters<typeof newChatModelSelection>[0]["project"] = project,
    carry: Pick<Parameters<typeof newChatModelSelection>[0], "carrySelection" | "sticky"> = {
      carrySelection: null,
      sticky: noSticky,
    },
  ) =>
    newChatModelSelection({
      config,
      settings: { ...DEFAULT_UNIFIED_SETTINGS, ...config.settings },
      project: target,
      ...carry,
    });
  const claudeOpus = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const claudeDefault = {
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus",
    },
  };

  it("uses the project's default model, then the environment's", () => {
    const config = testConfig([codex, claude], claudeDefault);
    expect(
      modelFor(config, {
        ...project,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-mini",
        },
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
    expect(modelFor(config)).toEqual({ instanceId: "claudeAgent", model: "claude-opus" });
  });

  it("falls back as a new chat does when nothing is set or the default cannot run", () => {
    // Nothing set: the first ready provider and its own default model.
    expect(modelFor(testConfig([codex, claude]))).toEqual({ instanceId: "codex", model: "gpt-5" });
    // The default's provider is unavailable here: a new chat opens on another.
    const claudeOff = testConfig(
      [codex, { ...claude, availability: "unavailable" } as ServerProvider],
      claudeDefault,
    );
    expect(modelFor(claudeOff)).toEqual({ instanceId: "codex", model: "gpt-5" });
  });

  it("carries the chat in view's model when neither the project nor the environment sets one", () => {
    const config = testConfig([codex, claude]);
    // A new chat opened from a Claude conversation opens on Claude; so does the import.
    expect(modelFor(config, project, { carrySelection: claudeOpus, sticky: noSticky })).toEqual(
      claudeOpus,
    );
    // The composer's remembered choice applies when nothing is carried.
    expect(
      modelFor(config, project, {
        carrySelection: null,
        sticky: {
          modelSelectionByProvider: { [claudeOpus.instanceId]: claudeOpus },
          activeProvider: claudeOpus.instanceId,
        },
      }),
    ).toEqual(claudeOpus);
    // A project default still wins over what is carried.
    expect(
      modelFor(
        config,
        {
          ...project,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-mini",
          },
        },
        { carrySelection: claudeOpus, sticky: noSticky },
      ),
    ).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
  });

  it("turns a historical Antigravity family into its live variant, as a new chat does", () => {
    const antigravityId = ProviderInstanceId.make("antigravity_work");
    const antigravity: ServerProvider = {
      ...testProvider("antigravity_work", "antigravity", []),
      models: ["low", "medium", "high"].map((level) => ({
        slug: `gemini-3.8-flash-${level}`,
        name: `Gemini 3.8 Flash (${level[0]!.toUpperCase() + level.slice(1)})`,
        isCustom: false,
        capabilities: {},
        isDefault: level === "high",
      })),
    };
    const historical = createModelSelection(antigravityId, "gemini-3.8-flash", [
      { id: "reasoning", value: "medium" },
    ]);
    const newChat = resolveAntigravityDraftSelection(historical, antigravity);
    expect(newChat?.model).toBe("gemini-3.8-flash-medium");
    const config = testConfig([antigravity], {
      providerInstances: {
        [antigravityId]: { driver: "antigravity", enabled: true },
      } as unknown as ServerConfig["settings"]["providerInstances"],
    });
    // Carried from the chat in view, and remembered by the composer.
    expect(modelFor(config, project, { carrySelection: historical, sticky: noSticky })).toEqual(
      newChat,
    );
    expect(
      modelFor(config, project, {
        carrySelection: null,
        sticky: {
          modelSelectionByProvider: { [antigravityId]: historical },
          activeProvider: antigravityId,
        },
      }),
    ).toEqual(newChat);
  });

  it("finds no model when no provider can run a chat, or before a project is known", () => {
    expect(modelFor(testConfig([]))).toBeNull();
    expect(
      modelFor(testConfig([{ ...codex, availability: "unavailable" } as ServerProvider])),
    ).toBeNull();
    expect(modelFor(testConfig([codex]), null)).toBeNull();
  });
});

describe("defaultImportProject", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const notes = { id: "notes", environmentId: local };
  const study = { id: "study", environmentId: remote };
  const survey = { id: "survey", environmentId: local };
  const thread = (projectId: string | null, environmentId: EnvironmentId, updatedAt: string) => ({
    id: `${projectId}-${updatedAt}`,
    environmentId,
    projectId,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    latestUserMessageAt: updatedAt,
    archivedAt: null,
  });
  const threads = [
    thread("notes", local, "2026-09-20T00:00:00.000Z"),
    thread("study", remote, "2026-09-25T00:00:00.000Z"),
    {
      ...thread("survey", local, "2026-09-28T00:00:00.000Z"),
      archivedAt: "2026-09-28T01:00:00.000Z",
    },
  ];

  it("takes the project in view, else the most recently active, else the first", () => {
    const available = [notes, study, survey];
    expect(
      defaultImportProject({
        available,
        current: { environmentId: local, projectId: "survey" },
        threads,
      }),
    ).toBe(survey);
    // Archived conversations do not count as recent activity.
    expect(defaultImportProject({ available, current: null, threads })).toBe(study);
    expect(defaultImportProject({ available, current: null, threads: [] })).toBe(notes);
  });

  it("only picks a project that is available", () => {
    expect(
      defaultImportProject({
        available: [notes, survey],
        current: { environmentId: remote, projectId: "study" },
        threads,
      }),
    ).toBe(notes);
    expect(defaultImportProject({ available: [], current: null, threads })).toBeNull();
  });
});
