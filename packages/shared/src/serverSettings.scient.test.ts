import {
  ComputeLanguageId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageAccountingSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection, resolveProviderModelPreferences } from "./model.ts";
import { applyServerSettingsPatch, isModelSelectionProviderEnabled } from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it.each([
    ["scient", true],
    ["droid", false],
  ] as const)("keeps fresh and configured %s selection eligibility consistent", (kind, enabled) => {
    const driver = ProviderDriverKind.make(kind);
    const instanceId = ProviderInstanceId.make(kind);
    const selection = createModelSelection(instanceId, "fixture-model");
    expect(isModelSelectionProviderEnabled(DEFAULT_SERVER_SETTINGS, selection)).toBe(enabled);
    const configured = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: { driver, config: {} } },
    };
    expect(isModelSelectionProviderEnabled(configured, selection)).toBe(enabled);
    for (const explicitEnabled of [true, false]) {
      expect(
        isModelSelectionProviderEnabled(
          {
            ...configured,
            providerInstances: { [instanceId]: { driver, enabled: explicitEnabled, config: {} } },
          },
          selection,
        ),
      ).toBe(explicitEnabled);
    }
    const namedId = ProviderInstanceId.make(`${kind}_work`);
    const namedSelection = createModelSelection(namedId, "fixture-model");
    expect(isModelSelectionProviderEnabled(DEFAULT_SERVER_SETTINGS, namedSelection)).toBe(false);
    expect(
      isModelSelectionProviderEnabled(
        {
          ...configured,
          providerInstances: { [namedId]: { driver, config: {} } },
        },
        namedSelection,
      ),
    ).toBe(enabled);
  });

  it("preserves an explicit scientific-language opt-out across narrow updates", () => {
    const python = ComputeLanguageId.make("python");
    const disabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      scientificComputing: {
        languages: { [python]: { enabled: false, executable: "/usr/bin/python3" } },
      },
    });
    expect(
      applyServerSettingsPatch(disabled, {
        scientificComputing: { languages: { [python]: { executable: "" } } },
      }).scientificComputing.languages[python],
    ).toEqual({ enabled: false, executable: "" });
  });

  it("upserts and removes usageAccountingSources per entry without clobbering", () => {
    const first = UsageAccountingSourceId.make("openrouter-a");
    const second = UsageAccountingSourceId.make("openrouter-b");
    const source = (label: string) => ({
      kind: "openrouter" as const,
      label,
      managementKey: "secret",
      enabled: true,
    });
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usageAccountingSources: { [first]: source("First") },
    });
    const added = applyServerSettingsPatch(current, {
      usageAccountingSources: { [second]: source("Second") },
    });
    expect(Object.keys(added.usageAccountingSources)).toEqual([first, second]);
    const removed = applyServerSettingsPatch(added, {
      usageAccountingSources: { [first]: null },
    });
    expect(Object.keys(removed.usageAccountingSources)).toEqual([second]);
  });
});

describe("atomic initialization of curated model preferences", () => {
  const provider = ProviderInstanceId.make("scient-personal");
  const unrelated = ProviderInstanceId.make("other-personal");
  const snapshot = { hiddenModels: ["curated-hidden"], modelOrder: ["first", "second"] };

  it.each(["scient"])(
    "preserves actual %s curation on the first visibility or order edit",
    (driver) => {
      const models = [
        { slug: "anthropic/claude-haiku-4-5", isCustom: false },
        { slug: "native/visible", isCustom: false },
      ];
      const initialPreferences = resolveProviderModelPreferences(driver, models, undefined);
      expect(initialPreferences.hiddenModels).toContain(models[0]!.slug);
      const hidden = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        setModelsHidden: [{ provider, model: models[1]!.slug, hidden: true, initialPreferences }],
      });
      expect(hidden.providerModelPreferences?.[provider]?.hiddenModels).toEqual([
        ...initialPreferences.hiddenModels,
        models[1]!.slug,
      ]);
      const ordered = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        setProviderModelOrder: { provider, modelOrder: [models[1]!.slug], initialPreferences },
      });
      expect(ordered.providerModelPreferences?.[provider]).toEqual({
        hiddenModels: initialPreferences.hiddenModels,
        modelOrder: [models[1]!.slug],
      });
    },
  );

  it.each([null, {}, { [unrelated]: { hiddenModels: ["other"], modelOrder: [] } }])(
    "initializes only the absent instance in a null, empty or populated map",
    (providerModelPreferences) => {
      const initial = { ...DEFAULT_SERVER_SETTINGS, providerModelPreferences };
      const changed = applyServerSettingsPatch(initial, {
        setModelsHidden: [{ provider, model: "added", hidden: true, initialPreferences: snapshot }],
      });
      expect(changed.providerModelPreferences?.[provider]).toEqual({
        ...snapshot,
        hiddenModels: ["curated-hidden", "added"],
      });
      expect(changed.providerModelPreferences?.[unrelated]).toEqual(
        providerModelPreferences?.[unrelated],
      );
    },
  );

  it("preserves both first edits and ignores the second client's stale initialization snapshot", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelsHidden: [
        { provider, model: "first-added", hidden: true, initialPreferences: snapshot },
      ],
    });
    const second = applyServerSettingsPatch(first, {
      setModelsHidden: [
        {
          provider,
          model: "second-added",
          hidden: true,
          initialPreferences: { hiddenModels: ["stale-hidden"], modelOrder: ["stale-order"] },
        },
      ],
    });
    expect(second.providerModelPreferences?.[provider]).toEqual({
      ...snapshot,
      hiddenModels: ["curated-hidden", "first-added", "second-added"],
    });
    expect(first.providerModelPreferences?.[provider]).toEqual({
      ...snapshot,
      hiddenModels: ["curated-hidden", "first-added"],
    });
    expect(snapshot).toEqual({ hiddenModels: ["curated-hidden"], modelOrder: ["first", "second"] });
  });

  it("retains an authoritative empty instance record across delayed initial snapshots", () => {
    const cleared = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: { [provider]: { hiddenModels: [], modelOrder: [] } },
    });
    const ordered = applyServerSettingsPatch(cleared, {
      setProviderModelOrder: { provider, modelOrder: ["next"], initialPreferences: snapshot },
    });
    expect(ordered.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: [],
      modelOrder: ["next"],
    });
    const hidden = applyServerSettingsPatch(cleared, {
      setModelsHidden: [
        { provider, model: "only-user-edit", hidden: true, initialPreferences: snapshot },
      ],
    });
    expect(hidden.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["only-user-edit"],
      modelOrder: [],
    });
  });

  it("keeps a deliberate order clear while retaining initialized visibility and later mutations", () => {
    const ordered = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setProviderModelOrder: { provider, modelOrder: [], initialPreferences: snapshot },
    });
    expect(ordered.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: snapshot.hiddenModels,
      modelOrder: [],
    });
    const shown = applyServerSettingsPatch(ordered, {
      setModelsHidden: [
        { provider, model: "curated-hidden", hidden: false, initialPreferences: snapshot },
      ],
    });
    expect(shown.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: [],
      modelOrder: [],
    });
    const anotherClient = applyServerSettingsPatch(shown, {
      setProviderModelOrder: { provider, modelOrder: [], initialPreferences: snapshot },
    });
    expect(anotherClient.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: [],
      modelOrder: [],
    });
  });
});
