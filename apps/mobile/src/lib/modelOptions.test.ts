import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { favoritesFirst } from "../features/threads/thread-settings-sheet-state";

import {
  buildModelOptions,
  describeUnavailableModelSelection,
  groupModelOptionsForDisplay,
  modelOptionReasoningControl,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
  type ModelOption,
} from "./modelOptions";

describe("mobile model options", () => {
  it.each(["pi", "omp", "scient"])(
    "uses curated %s defaults and does not reinsert a hidden saved model",
    (driver) => {
      const config = {
        providers: [
          {
            instanceId: driver,
            driver,
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            models: [
              "google-antigravity/claude-opus-4-5",
              "google-antigravity/claude-opus-4-6",
              "google-antigravity/gemini-3.8-flash",
              "google-antigravity/gemini-3.1-pro",
              "anthropic/claude-haiku-4-5",
              "anthropic/claude-opus-5-5",
              "openai-codex/gpt-6-sol",
              "openai-codex/gpt-6-luna",
            ].map((slug) => ({
              slug,
              name: slug,
              isCustom: false,
              capabilities: null,
              isDefault: slug.includes("haiku"),
            })),
          },
        ],
      } as unknown as ServerConfig;
      const saved = {
        instanceId: ProviderInstanceId.make(driver),
        model: "anthropic/claude-haiku-4-5",
      };
      const options = buildModelOptions(config, saved, undefined, null);
      expect(options.map((model) => model.selection.model)).toEqual([
        "anthropic/claude-opus-5-5",
        "openai-codex/gpt-6-luna",
        "google-antigravity/claude-opus-4-6",
        "google-antigravity/gemini-3.8-flash",
        "google-antigravity/gemini-3.1-pro",
      ]);
      expect(options.some((model) => model.isDefault)).toBe(true);
      expect(resolveDefaultableModelSelection(config, saved, null)).toBeNull();
    },
  );
  it("does not reinsert a known unavailable saved model into the mobile picker", () => {
    const config = {
      providers: [
        {
          instanceId: "omp",
          driver: "omp",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          models: [
            {
              slug: "native/blocked",
              name: "Blocked",
              unavailableReason: "Account access required.",
              isDefault: true,
              isCustom: false,
              capabilities: null,
            },
            { slug: "native/unknown", name: "Unverified", isCustom: false, capabilities: null },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const saved = { instanceId: ProviderInstanceId.make("omp"), model: "native/blocked" };
    expect(
      buildModelOptions(config, saved, undefined, null).map((option) => option.selection.model),
    ).toEqual(["native/unknown"]);
    expect(isModelSelectionUnavailable(config, saved, null)).toBe(true);
    expect(resolveDefaultableModelSelection(config, saved, null)).toBeNull();
  });

  it("keeps the update-required advisory for a saved selection when provider probing errors", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "gpt-5.6-sol",
    };
    const updateRequiredModels = [{ slug: "gpt-next", name: "GPT Next", minVersion: "1.2.0" }];
    const config = {
      providers: [
        {
          instanceId: "codex_work",
          driver: "codex",
          displayName: "Codex Work",
          enabled: true,
          installed: true,
          status: "error",
          auth: { status: "unknown" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
          ],
          updateRequiredModels,
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, selection, undefined, null))).toMatchObject([
      {
        providerKey: "codex_work",
        providerLabel: "Codex Work",
        updateRequired: { driver: "codex", updateRequiredModels },
        models: [{ selection }],
      },
    ]);
  });

  it.each(["droid", "pi"])(
    "consumes %s discovered connections without legacy model settings",
    (driver) => {
      const slug = driver === "droid" ? "custom:scient-fixture" : "scient_fixture/model";
      const provider = {
        instanceId: driver,
        driver,
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug, name: "Connected model", isCustom: false, capabilities: null }],
      };
      const config = { providers: [provider] } as unknown as ServerConfig;
      expect(
        buildModelOptions(config, null, undefined, null).map((option) => option.selection),
      ).toEqual([{ instanceId: driver, model: slug }]);
      provider.models = [];
      expect(buildModelOptions(config, null, undefined, null)).toEqual([]);
    },
  );

  it("groups the picker but preserves native selections and rebuilds controls from the account catalog", () => {
    const provider = {
      instanceId: "google_work",
      driver: "antigravity",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      availability: "available",
      models: ["High", "Medium", "Low"].map((level) => ({
        slug: `gemini-3.8-flash-${level.toLowerCase()}`,
        name: `Gemini 3.8 Flash (${level})`,
        isCustom: false,
        isDefault: level === "High",
        capabilities: { optionDescriptors: [] },
      })),
    };
    const config = { providers: [provider] } as unknown as ServerConfig;
    const saved: ModelSelection = {
      instanceId: ProviderInstanceId.make("google_work"),
      model: "gemini-3.8-flash-low",
    };
    const options = buildModelOptions(config, saved, undefined, null);
    expect(options).toHaveLength(3);
    const rows = groupModelOptionsForDisplay(options, saved.model);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Gemini 3.8 Flash");
    expect(rows[0]?.selection).toEqual(saved);
    const favoriteKeys = new Set([
      options.find((option) => option.selection.model === saved.model)!.key,
    ]);
    const favoriteRows = groupModelOptionsForDisplay(
      favoritesFirst(
        options.filter((option) => favoriteKeys.has(option.key)),
        favoriteKeys,
      ),
      "gemini-3.8-flash-high",
    );
    // Filtering a favorite must not substitute another reasoning variant, even
    // when the selected/default model is outside the filtered catalog.
    expect(favoriteRows).toHaveLength(1);
    expect(favoriteRows[0]?.selection).toEqual(saved);
    expect(options).toHaveLength(3);
    const control = modelOptionReasoningControl(rows[0]);
    expect(control?.currentValue).toBe(saved.model);
    const high = options.find((option) => option.selection.model === control?.options[2]?.id)!;
    expect(high.selection).toEqual({ ...saved, model: "gemini-3.8-flash-high" });
    // No reasoning value is stored separately or converted into an invented base ID.
    expect(high.selection.options).toBeUndefined();
    provider.models = provider.models.filter((model) => model.slug !== saved.model);
    const refreshed = buildModelOptions(config, saved, undefined, null);
    const missing = refreshed.find((option) => option.selection.model === saved.model)!;
    expect(missing.isUnavailable).toBe(true);
    expect(modelOptionReasoningControl(missing)).toBeNull();
    expect(groupModelOptionsForDisplay(refreshed, saved.model)).toContainEqual(missing);
  });
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null, undefined, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", subtitle: "", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("carries configured ACP identity into model and provider catalogs", () => {
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg";
    const config = {
      providers: [
        {
          instanceId: "acpRegistry_antigravity",
          driver: "acpRegistry",
          displayName: "Antigravity",
          iconUrl,
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "default",
              name: "Default",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [group] = groupByProvider(buildModelOptions(config, null, undefined, null));

    expect(group).toMatchObject({
      providerKey: "acpRegistry_antigravity",
      providerLabel: "Antigravity",
      models: [
        {
          providerDriver: "acpRegistry",
          providerIconUrl: iconUrl,
        },
      ],
    });
  });

  it("distinguishes same-name OpenCode models without changing their routing", () => {
    const sources = [
      { id: "anthropic", label: "Anthropic" },
      { id: "github-copilot", label: "GitHub Copilot" },
      { id: "opencode", label: "OpenCode Zen" },
    ];
    const config = {
      providers: [
        {
          instanceId: "opencode_work",
          driver: "opencode",
          displayName: "OpenCode Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: sources.map((source) => ({
            slug: `${source.id}/claude-fable-5`,
            name: "Claude Fable 5",
            subProvider: source.label,
            isCustom: false,
            capabilities: null,
          })),
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("opencode_work"),
      model: "github-copilot/claude-fable-5",
    };

    const options = buildModelOptions(config, selection, undefined, null);

    expect(options).toMatchObject(
      sources.map((source) => ({
        key: `opencode_work:${source.id}/claude-fable-5`,
        label: "Claude Fable 5",
        subtitle: source.label,
        providerLabel: "OpenCode Work",
        selection: {
          instanceId: "opencode_work",
          model: `${source.id}/claude-fable-5`,
        },
      })),
    );
    expect(groupByProvider(options)).toEqual([
      { providerKey: "opencode_work", providerLabel: "OpenCode Work", models: options },
    ]);
  });

  it("does not materialize catalog defaults for missing stored options", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
      },
      undefined,
      null,
    );

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toBeUndefined();

    const [emptyOption] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
        options: [],
      },
      undefined,
      null,
    );
    expect(emptyOption?.selection).toEqual(option?.selection);

    const [explicitOption] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
        options: [{ id: "serviceTier", value: "priority" }],
      },
      undefined,
      null,
    );
    expect(explicitOption?.selection.options).toEqual([{ id: "serviceTier", value: "priority" }]);
  });

  it("limits existing threads to their provider while new tasks keep every provider", () => {
    const providers = ["codex", "claudeAgent"].map((instanceId) => ({
      instanceId,
      driver: instanceId,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "test", name: instanceId, capabilities: null }],
    }));
    const config = { providers } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };

    expect(
      buildModelOptions(config, selection, undefined, null).map((option) => option.providerKey),
    ).toEqual(["codex", "claudeAgent"]);
    expect(buildModelOptions(config, selection, selection.instanceId, null)).toEqual(
      buildModelOptions(config, selection, undefined, null).filter(
        (option) => option.providerKey === "codex",
      ),
    );
  });

  it.each(["disabled", "unavailable", "missing"] as const)(
    "retains the selected %s provider's fallback in a filtered catalog",
    (state) => {
      const selection = {
        instanceId: ProviderInstanceId.make("google_work"),
        model: "saved-model",
        options: [{ id: "native-option", value: "saved-choice" }],
      };
      const provider = {
        instanceId: selection.instanceId,
        driver: "antigravity",
        displayName: "Google Work",
        enabled: state !== "disabled",
        installed: true,
        availability: state === "unavailable" ? "unavailable" : "available",
        auth: { status: "authenticated" },
        models: [{ slug: selection.model, name: "Saved model", capabilities: null }],
      };
      const config = {
        providers: state === "missing" ? [] : [provider],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            google_work: { driver: "antigravity", enabled: state !== "disabled" },
          },
        },
      } as unknown as ServerConfig;
      const options = buildModelOptions(config, selection, selection.instanceId, null);
      expect(options).toEqual(buildModelOptions(config, selection, undefined, null));
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection, isUnavailable: true });
    },
  );

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable, null)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled, null)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed, null)).toBeNull();
    // Disabled is disabled even with no settings to consult; only a provider
    // that is merely missing or unauthenticated falls through silently.
    expect(isModelSelectionUnavailable(config, disabled, null)).toBe(true);
    expect(isModelSelectionUnavailable(config, removed, null)).toBe(false);
    // An offline environment has no config to validate.
    expect(resolveSelectableModelSelection(null, disabled, null)).toBe(disabled);
  });

  describe("Antigravity selections", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("google_work"),
      model: "gemini-3.1-pro-high",
      options: [{ id: "native-option", value: "saved/opaque-choice" }],
    };
    const model = {
      slug: selection.model,
      name: "Gemini 3.1 Pro High",
      subProvider: "Google",
      isCustom: false,
      isDefault: true,
      isLegacy: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "native-option",
            label: "Native option",
            type: "select",
            options: [{ id: "current/default", label: "Default", isDefault: true }],
            currentValue: "current/default",
          },
        ],
      },
    };
    const config = {
      providers: [
        {
          instanceId: selection.instanceId,
          driver: "antigravity",
          displayName: "Google Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [model],
        },
      ],
    } as unknown as ServerConfig;

    it.each([
      ["disabled", { enabled: false }],
      ["uninstalled", { installed: false }],
      ["signed out", { auth: { status: "unauthenticated" } }],
      ["unavailable", { availability: "unavailable" }],
    ] as const)("keeps a %s provider's selection and known model details", (_state, update) => {
      const unavailableConfig = {
        ...config,
        providers: config.providers.map((provider) => ({ ...provider, ...update })),
      };

      expect(resolveSelectableModelSelection(unavailableConfig, selection, null)).toBe(selection);
      expect(resolveDefaultableModelSelection(unavailableConfig, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(unavailableConfig, selection, null)).toBe(true);
      expect(buildModelOptions(unavailableConfig, null, undefined, null)).toEqual([]);
      const [option] = buildModelOptions(unavailableConfig, selection, undefined, null);
      expect(option).toMatchObject({
        key: `google_work:${selection.model}`,
        label: model.name,
        subtitle: "Google",
        providerKey: "google_work",
        providerLabel: "Google Work",
        providerDriver: "antigravity",
        isDefault: false,
        isLegacy: true,
        isUnavailable: true,
        capabilities: model.capabilities,
      });
      expect(option?.selection).toBe(selection);
    });

    it("keeps an exact selection when its model leaves and returns to the catalog", () => {
      const changedConfig = {
        ...config,
        providers: config.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, slug: "gemini-3.1-pro-low" })),
        })),
      };

      expect(resolveDefaultableModelSelection(changedConfig, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(changedConfig, selection, null)).toBe(true);
      const options = buildModelOptions(changedConfig, selection, undefined, null);
      const missing = options.find((option) => option.selection.model === selection.model);
      expect(missing).toMatchObject({
        label: selection.model,
        providerLabel: "Google Work",
        providerDriver: "antigravity",
        isUnavailable: true,
        capabilities: null,
      });
      expect(missing?.selection).toBe(selection);
      expect(
        resolveNewTaskModelSelection({
          draftSelection: null,
          projectDefaultSelection: resolveDefaultableModelSelection(changedConfig, selection, null),
          stickySelection: null,
          modelOptions: options,
        }),
      ).toBe(selection);

      const [restored] = buildModelOptions(config, selection, undefined, null);
      expect(isModelSelectionUnavailable(config, selection, null)).toBe(false);
      expect(restored?.isUnavailable).not.toBe(true);
      expect(restored?.selection).toBe(selection);
      expect(resolveDefaultableModelSelection(config, selection, null)).toBe(selection);
      expect(
        buildModelOptions(config, null, undefined, null)[0]?.selection.options,
      ).toBeUndefined();
    });

    it("uses configured instance metadata when provider status is missing", () => {
      const missingStatusConfig = {
        providers: [],
        settings: {
          providerInstances: {
            [selection.instanceId]: { driver: "antigravity", displayName: "Google Work" },
          },
        },
      } as unknown as ServerConfig;

      expect(resolveDefaultableModelSelection(missingStatusConfig, selection, null)).toBe(
        selection,
      );
      expect(isModelSelectionUnavailable(missingStatusConfig, selection, null)).toBe(true);
      expect(buildModelOptions(missingStatusConfig, selection, undefined, null)).toMatchObject([
        {
          providerDriver: "antigravity",
          providerLabel: "Google Work",
          isUnavailable: true,
          selection,
        },
      ]);
    });

    it("keeps offline selections without assuming that an unknown instance is Antigravity", () => {
      const unknownConfig = { ...config, providers: [] };

      expect(resolveDefaultableModelSelection(null, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(null, selection, null)).toBe(false);
      expect(buildModelOptions(null, selection, undefined, null)[0]?.selection).toBe(selection);
      expect(buildModelOptions(null, selection, undefined, null)[0]?.isUnavailable).not.toBe(true);
      expect(isModelSelectionUnavailable(unknownConfig, selection, null)).toBe(false);
      expect(resolveSelectableModelSelection(unknownConfig, selection, null)).toBeNull();
    });
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current, null)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy, null)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy, null)).toBe(legacy);
  });

  it("resolves new tasks from draft, project, sticky, then provider defaults", () => {
    const draft = { instanceId: ProviderInstanceId.make("codex"), model: "draft" };
    const project = { instanceId: ProviderInstanceId.make("codex"), model: "project" };
    const sticky = { instanceId: ProviderInstanceId.make("codex"), model: "sticky" };
    const providerDefault = {
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
      isDefault: true,
    } as ModelOption;
    const resolve = (
      draftSelection: ModelSelection | null,
      projectDefaultSelection: ModelSelection | null,
      stickySelection: ModelSelection | null,
    ) =>
      resolveNewTaskModelSelection({
        draftSelection,
        projectDefaultSelection,
        stickySelection,
        modelOptions: [providerDefault],
      });

    expect(resolve(draft, project, sticky)).toBe(draft);
    expect(resolve(null, project, sticky)).toBe(project);
    expect(resolve(null, null, sticky)).toBe(sticky);
    expect(resolve(null, null, null)).toBe(providerDefault.selection);

    const unavailable = { ...providerDefault, isUnavailable: true };
    expect(
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: null,
        modelOptions: [unavailable],
      }),
    ).toBeNull();
  });

  describe("project-aware enablement", () => {
    const projectId = ProjectId.make("project-a");
    const instanceId = ProviderInstanceId.make("codex_work");

    function configWith(settings: ServerSettings): ServerConfig {
      return {
        providers: [
          {
            instanceId,
            driver: "codex",
            displayName: "Codex Work",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
          },
        ],
        settings,
      } as unknown as ServerConfig;
    }

    it("words a project's own turn-off apart from missing setup", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(
        describeUnavailableModelSelection(configWith(settings), selection, projectId).title,
      ).toBe("Model turned off for this project");
      expect(describeUnavailableModelSelection(configWith(settings), selection, null).title).toBe(
        "Antigravity model unavailable",
      );
    });

    it("refuses to send a non-Antigravity model the project turned off", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(false);
    });

    it("hides an instance the project disables even though the machine enables it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("shows an instance the project enables even though the machine disables it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toHaveLength(1);
    });

    it("falls back to the machine value with no project in scope", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, null)).toHaveLength(1);
    });

    it("hides a machine-disabled instance for a project with no override, even though another project's keep-alive left it running", () => {
      const otherProjectId = ProjectId.make("project-b");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
        projectSettingsOverrides: {
          [otherProjectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      };

      // configWith's snapshot always reports enabled: true, standing in for
      // the server keeping the instance alive to serve project-b's override.
      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("refuses to send an instance the project merely inherits as disabled, not just an explicit override", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
      };
      const selection = { instanceId, model: "model-a" };

      // configWith's snapshot always reports enabled: true, standing in for
      // the server keeping the instance alive for another project's keep-alive.
      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(
        describeUnavailableModelSelection(configWith(settings), selection, projectId).title,
      ).toBe("Model turned off for this project");
      // With no project in scope, the machine value applies and is disabled.
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(true);
    });

    it("marks a project-disabled instance's fallback selection unavailable instead of reviving it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const fallback = { instanceId, model: "model-a" };

      const options = buildModelOptions(configWith(settings), fallback, undefined, projectId);

      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection: fallback, isUnavailable: true });
    });

    it("rejects a project-disabled instance's selection via resolveSelectableModelSelection", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(
        resolveSelectableModelSelection(configWith(settings), selection, projectId),
      ).toBeNull();
      expect(resolveSelectableModelSelection(configWith(settings), selection, null)).toBe(
        selection,
      );
    });

    it("rejects a project-disabled antigravity instance's selection instead of keeping it", () => {
      const antigravityInstanceId = ProviderInstanceId.make("antigravity_work");
      const config = {
        providers: [
          {
            instanceId: antigravityInstanceId,
            driver: "antigravity",
            displayName: "Antigravity Work",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            availability: "available",
            models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
          },
        ],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [antigravityInstanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              enabled: true,
            },
          },
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [antigravityInstanceId]: { enabled: false } } },
          },
        },
      } as unknown as ServerConfig;
      const selection = { instanceId: antigravityInstanceId, model: "model-a" };

      expect(resolveSelectableModelSelection(config, selection, projectId)).toBeNull();
      expect(resolveSelectableModelSelection(config, selection, null)).toBe(selection);
      expect(
        resolveSelectableModelSelection({ ...config, providers: [] }, selection, projectId),
      ).toBeNull();
    });
  });
});

describe("synchronized mobile model visibility", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const other = ProviderInstanceId.make("codex_personal");
  const models = [
    { slug: "hidden", name: "Hidden", isCustom: false, capabilities: null },
    { slug: "first", name: "First", isCustom: false, capabilities: null },
    { slug: "second", name: "Second", isCustom: false, capabilities: null },
    { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
  ];
  const config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      // A live snapshot entry always has a matching configured instance (or
      // is a driver's own default id); these are stand-ins for neither, so
      // the enablement fixture needs its own entry to read as enabled.
      providerInstances: {
        [provider]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        [other]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      providerModelPreferences: {
        [provider]: {
          hiddenModels: ["hidden", "custom", "missing"],
          modelOrder: ["second", "first"],
        },
      },
    },
    providers: [provider, other].map((instanceId) => ({
      instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models,
    })),
  } as unknown as ServerConfig;

  it("applies server visibility and ordering independently to each provider instance", () => {
    const options = buildModelOptions(config, null, undefined, null);
    expect(
      options
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["second", "first", "custom"]);
    expect(
      options
        .filter((option) => option.providerKey === other)
        .map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  it("exposes hidden built-ins for management without offering custom visibility controls", () => {
    const options = buildModelOptions(
      config,
      { instanceId: provider, model: "hidden" },
      provider,
      null,
      true,
    );
    expect(options.map((option) => option.selection.model)).toEqual([
      "second",
      "first",
      "hidden",
      "custom",
    ]);
    expect(options.find((option) => option.selection.model === "hidden")).toMatchObject({
      isHidden: true,
      canHide: true,
    });
    expect(options.find((option) => option.selection.model === "custom")).toMatchObject({
      isHidden: false,
      canHide: false,
    });
  });

  it.each(["hidden", "missing"])("does not resurrect the hidden fallback %s", (model) => {
    expect(
      buildModelOptions(config, { instanceId: provider, model }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toEqual(["second", "first", "custom"]);
  });

  it("keeps custom models visible and restores built-in models when the server clears hidden models", () => {
    expect(
      buildModelOptions(config, { instanceId: provider, model: "custom" }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toContain("custom");
    const cleared = { ...config, settings: { ...config.settings, providerModelPreferences: {} } };
    expect(
      buildModelOptions(cleared, null, provider, null).map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });
});

describe("mobile environment model preferences", () => {
  it.each(["pi", "omp", "scient"])("honors authoritative empty visibility for %s", (driver) => {
    const instanceId = ProviderInstanceId.make(driver);
    const selection = { instanceId, model: "anthropic/claude-haiku-4-5" };
    const provider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      auth: { status: "unknown" },
      models: [
        { slug: selection.model, name: "Haiku", isCustom: false, capabilities: null },
        { slug: "native/custom", name: "Custom", isCustom: true, capabilities: null },
      ],
    };
    const config = {
      providers: [provider],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: { driver, enabled: true } },
        providerModelPreferences: { [instanceId]: { hiddenModels: [], modelOrder: [] } },
      },
    } as unknown as ServerConfig;
    expect(
      buildModelOptions(config, selection, undefined, null).some(
        (option) => option.selection.model === selection.model,
      ),
    ).toBe(true);
    expect(resolveDefaultableModelSelection(config, selection, null)).toEqual(selection);
    const hidden = {
      ...config,
      settings: {
        ...config.settings,
        providerModelPreferences: {
          [instanceId]: { hiddenModels: [selection.model], modelOrder: [] },
        },
      },
    };
    expect(
      buildModelOptions(hidden, selection, undefined, null).some(
        (option) => option.selection.model === selection.model,
      ),
    ).toBe(false);
    expect(resolveDefaultableModelSelection(hidden, selection, null)).toBeNull();
    expect(
      buildModelOptions(hidden, null, undefined, null, true).find(
        (option) => option.selection.model === selection.model,
      ),
    ).toMatchObject({ isHidden: true, canHide: true });
    expect(
      buildModelOptions(hidden, null, undefined, null).find(
        (option) => option.selection.model === "native/custom",
      ),
    ).toMatchObject({ canHide: false });
  });
});
