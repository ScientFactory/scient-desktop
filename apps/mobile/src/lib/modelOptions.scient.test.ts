import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
} from "@t3tools/contracts";
import { favoritesFirst } from "../features/threads/thread-settings-sheet-state";

import {
  buildModelOptions,
  groupByProvider,
  groupModelOptionsForDisplay,
  isModelSelectionUnavailable,
  modelOptionReasoningControl,
  resolveDefaultableModelSelection,
} from "./modelOptions";

describe("Scient mobile model options", () => {
  // pi and omp share the curated-visibility branch; scient also picks its own automatic model.
  it.each(["pi", "scient"])(
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
  // regression: 8b55e253a2 fix(models): exclude known unavailable models from selection
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

  // droid takes the uncurated branch, pi the curated native-agent branch.
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
});

describe("mobile environment model preferences", () => {
  // Every native agent driver takes the same saved-visibility branch.
  it.each(["pi"])("honors authoritative empty visibility for %s", (driver) => {
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
