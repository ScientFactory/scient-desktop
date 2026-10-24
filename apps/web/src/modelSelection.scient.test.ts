import {
  DROID_DEFAULT_MODEL,
  PI_DEFAULT_TEXT_GENERATION_MODEL,
  SCIENT_DEFAULT_TEXT_GENERATION_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
} from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelection,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
  supportsTextGeneration?: boolean;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

// Native agents (Pi, OMP, Scient) share one selection branch; Scient also formats its slugs.
describe("native agent model selection", () => {
  it.each(["pi", "scient"])(
    "applies curated %s defaults without replacing saved visibility",
    (kind) => {
      const native = provider({
        provider: ProviderDriverKind.make(kind),
        instanceId: kind,
        models: [
          "google-antigravity/claude-opus-4-5",
          "google-antigravity/claude-opus-4-6",
          "google-antigravity/gemini-3.8-flash",
          "google-antigravity/gemini-3.1-pro",
          "anthropic/claude-haiku-4-5",
          "anthropic/claude-sonnet-5-5",
          "openai-codex/gpt-6-sol",
          "openai-codex/gpt-6.1-sol",
        ],
      });
      const entry = deriveProviderInstanceEntries([native])[0]!;
      const selected = getAppModelOptionsForInstance(
        DEFAULT_UNIFIED_SETTINGS,
        entry,
        "anthropic/claude-haiku-4-5",
      );
      expect(selected.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-5-5",
        "openai-codex/gpt-6.1-sol",
        "google-antigravity/claude-opus-4-6",
        "google-antigravity/gemini-3.8-flash",
        "google-antigravity/gemini-3.1-pro",
      ]);
      expect(
        resolveAppModelSelectionForInstance(
          entry.instanceId,
          DEFAULT_UNIFIED_SETTINGS,
          [native],
          "anthropic/claude-haiku-4-5",
        ),
      ).toBe("anthropic/claude-sonnet-5-5");
      expect(
        resolveAppModelSelection(
          native.driver,
          DEFAULT_UNIFIED_SETTINGS,
          [native],
          "anthropic/claude-haiku-4-5",
        ),
      ).toBe("anthropic/claude-sonnet-5-5");
      expect(
        resolveAppModelSelection(
          native.driver,
          DEFAULT_UNIFIED_SETTINGS,
          [{ ...native, models: native.models.slice(0, 1) }],
          null,
        ),
      ).toBe("");
      expect(
        resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, [
          { ...native, models: native.models.slice(0, 1) },
        ]).model,
      ).toBe("");

      const saved = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: { [entry.instanceId]: { hiddenModels: [], modelOrder: [] } },
      };
      expect(getAppModelOptionsForInstance(saved, entry).map((model) => model.slug)).toEqual([
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-sonnet-5-5",
        "openai-codex/gpt-6-sol",
        "openai-codex/gpt-6.1-sol",
        "google-antigravity/claude-opus-4-5",
        "google-antigravity/claude-opus-4-6",
        "google-antigravity/gemini-3.8-flash",
        "google-antigravity/gemini-3.1-pro",
      ]);
    },
  );

  // regression: 3766d2d0fd fix(models): leave selection empty when all models are unavailable
  it.each(["pi", "claudeAgent"])(
    "does not invent a default when every %s model is unavailable",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      const blocked: ServerProvider = {
        ...provider({ provider: driver, instanceId: kind }),
        models: [
          {
            slug: "native/blocked",
            name: "Blocked",
            isCustom: false,
            unavailableReason: "Account access required.",
            capabilities: null,
          },
        ],
      };
      expect(resolveAppModelSelection(driver, DEFAULT_UNIFIED_SETTINGS, [blocked], null)).toBe("");
    },
  );

  it.each(["pi"])(
    "does not revive a native default after every %s model is explicitly hidden",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      const native = provider({
        provider: driver,
        instanceId: kind,
        models: ["native/available"],
      });
      const settings: UnifiedSettings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [native.instanceId]: { hiddenModels: ["native/available"], modelOrder: [] },
        },
      };
      expect(resolveAppModelSelection(driver, settings, [native], "native/available")).toBe("");
      expect(
        resolveAppModelSelectionForInstance(
          native.instanceId,
          settings,
          [native],
          "native/available",
        ),
      ).toBeNull();
    },
  );

  // regression: 8b55e253a2 fix(models): exclude known unavailable models from selection
  it.each(["pi"])(
    "excludes known unavailable %s models even when selected or configured as custom",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      const entry: ServerProvider = {
        ...provider({ provider: driver, instanceId: kind }),
        models: [
          {
            slug: "native/blocked",
            name: "Blocked",
            isCustom: false,
            isDefault: true,
            unavailableReason: "Account access required.",
            capabilities: null,
          },
          { slug: "native/unknown", name: "Unverified", isCustom: false, capabilities: null },
        ],
      };
      const settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [entry.instanceId]: { driver, config: { customModels: ["native/blocked"] } },
        },
      };
      const projected = deriveProviderInstanceEntries([entry])[0]!;
      expect(
        getAppModelOptionsForInstance(settings, projected, "native/blocked").map(
          (option) => option.slug,
        ),
      ).toEqual(["native/unknown"]);
      expect(getDefaultProviderInstanceModel([entry], entry.instanceId)).toBe("native/unknown");
    },
  );

  it.each(["droid", "pi"] as const)(
    "keeps %s discovered BYOK models selectable, scoped, hideable, and removable",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      const nativeSlug = kind === "droid" ? "custom:personal" : "native/model";
      const connectedSlug = kind === "droid" ? "custom:scient-fixture" : "scient_fixture/model";
      const primary = provider({
        provider: driver,
        instanceId: kind,
        models: [nativeSlug, connectedSlug],
      });
      const other = provider({
        provider: driver,
        instanceId: `${kind}_other`,
        models: [nativeSlug],
      });
      const entries = deriveProviderInstanceEntries([primary, other]);
      const settings: UnifiedSettings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [primary.instanceId]: {
            driver,
            config: { customModels: [connectedSlug, "manual-only"] },
          },
        },
      };
      const options = getAppModelOptionsForInstance(settings, entries[0]!);
      expect(options.map((option) => option.slug)).toEqual([
        nativeSlug,
        connectedSlug,
        "manual-only",
      ]);
      expect(options.find((option) => option.slug === connectedSlug)?.isCustom).toBe(false);
      expect(resolveAppModelSelection(driver, settings, [primary, other], connectedSlug)).toBe(
        connectedSlug,
      );
      expect(
        getAppModelOptionsForInstance(settings, entries[1]!).map((option) => option.slug),
      ).toEqual([nativeSlug]);
      const hidden: UnifiedSettings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [primary.instanceId]: { hiddenModels: [connectedSlug], modelOrder: [] },
        },
      };
      expect(
        getAppModelOptionsForInstance(hidden, entries[0]!).map((option) => option.slug),
      ).toEqual([nativeSlug]);
      expect(
        resolveAppModelSelectionForInstance(
          primary.instanceId,
          settings,
          [primary, other],
          connectedSlug,
        ),
      ).toBe(connectedSlug);
      const removed = deriveProviderInstanceEntries([
        { ...primary, models: primary.models.slice(0, 1) },
      ])[0]!;
      expect(
        getAppModelOptionsForInstance(DEFAULT_UNIFIED_SETTINGS, removed).map(
          (option) => option.slug,
        ),
      ).toEqual([nativeSlug]);
    },
  );

  it("resolves Droid's default marker to the model Droid reports, not the first listed", () => {
    const instanceId = ProviderInstanceId.make("droid");
    const base = provider({
      provider: ProviderDriverKind.make("droid"),
      instanceId,
      models: ["claude-fable-5.1", "gpt-6-sol"],
    });
    const droid = {
      ...base,
      models: base.models.map((model) =>
        model.slug === "gpt-6-sol" ? { ...model, isDefault: true } : model,
      ),
    };
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationModelSelection: { instanceId, model: DROID_DEFAULT_MODEL },
    };

    // Settings shows the model the marker stands for; a new thread starts on it too.
    expect(resolveAppModelSelectionState(settings, [droid]).model).toBe("gpt-6-sol");
    expect(getDefaultProviderInstanceModel([droid], instanceId)).toBe("gpt-6-sol");
  });

  // regression: 234475659b fix(provider): resolve automatic Pi and OMP metadata models
  it.each([
    ["pi", PI_DEFAULT_TEXT_GENERATION_MODEL],
    ["scient", SCIENT_DEFAULT_TEXT_GENERATION_MODEL],
  ] as const)(
    "shows %s's automatic native model without changing stored settings",
    (driver, marker) => {
      const instanceId = ProviderInstanceId.make(`${driver}_work`);
      const base = provider({
        provider: ProviderDriverKind.make(driver),
        instanceId,
        models: ["openai/hosted", "local/team%2Fmodel"],
      });
      const discovered = {
        ...base,
        models: base.models.map((model) =>
          model.slug === "local/team%2Fmodel" ? { ...model, isDefault: true } : model,
        ),
      };
      const storedSelection = createModelSelection(instanceId, marker);
      const settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        textGenerationModelSelection: storedSelection,
      };
      expect(resolveAppModelSelectionState(settings, [discovered]).model).toBe(
        "local/team%2Fmodel",
      );
      expect(settings.textGenerationModelSelection).toBe(storedSelection);
      expect(getDefaultProviderInstanceModel([discovered], instanceId)).toBe("local/team%2Fmodel");
      expect(resolveAppModelSelectionState(settings, [{ ...discovered, models: [] }]).model).toBe(
        "",
      );
    },
  );
});
