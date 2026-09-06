import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type CustomModelConnection } from "@t3tools/contracts";
import {
  customModelDiscoverySnapshot,
  customModelRuntimeChange,
  effectiveCustomModelReasoning,
} from "./customModelCapabilities.ts";
import { piCustomModelReasoning } from "./provider/pi/PiCustomModels.ts";
import { buildDroidCustomModelsSettings } from "./provider/droid/DroidCustomModels.ts";

const instanceId = ProviderInstanceId.make("pi");
const source: CustomModelConnection = {
  id: "fixture",
  name: "Fixture",
  protocol: "openai-completions",
  baseUrl: "http://localhost:9000/v1",
  credentialId: null,
  models: [
    {
      id: "model",
      modelId: "fixture",
      name: "Fixture",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      images: false,
      reasoning: false,
      instanceIds: [instanceId],
    },
  ],
};

describe("custom-model capability projection", () => {
  it("separates non-revoking refreshes from loaded authority revocation", () => {
    const model = source.models[0]!;
    const addition = { ...source, models: [model, { ...model, id: "second", modelId: "second" }] };
    expect(customModelRuntimeChange([source], [addition], instanceId)).toBe("refresh");
    expect(
      customModelRuntimeChange(
        [source],
        [{ ...source, models: [{ ...model, imageInput: "automatic" }] }],
        instanceId,
      ),
    ).toBe("refresh");
    expect(
      customModelRuntimeChange(
        [source],
        [{ ...source, models: [{ ...model, maxOutputTokens: 16000 }] }],
        instanceId,
      ),
    ).toBe("refresh");
    expect(
      customModelRuntimeChange(
        [source],
        [
          {
            ...source,
            name: "Renamed",
            models: [{ ...model, name: "Renamed", defaultReasoningLevel: "high" }],
          },
        ],
        instanceId,
      ),
    ).toBe("unchanged");
    const unloaded = { ...source, id: "unloaded", credentialId: "new" };
    expect(customModelRuntimeChange([source], [source, unloaded], instanceId)).toBe("refresh");
    const other = ProviderInstanceId.make("other");
    expect(
      customModelRuntimeChange(
        [source],
        [source, { ...unloaded, models: [{ ...model, instanceIds: [other] }] }],
        instanceId,
      ),
    ).toBe("unchanged");
    for (const current of [
      [],
      [{ ...source, credentialId: "rotated" }],
      [{ ...source, baseUrl: "https://other.example/v1" }],
      [{ ...source, protocol: "openai-responses" as const }],
      [{ ...source, models: [{ ...model, instanceIds: [other] }] }],
      [{ ...source, models: [{ ...model, modelId: "replaced" }] }],
    ])
      expect(customModelRuntimeChange([source], current, instanceId)).toBe("revoke");
    // B is not selected, but its key is resident in this process.
    expect(customModelRuntimeChange([source, unloaded], [source], instanceId)).toBe("revoke");
  });
  it("applies explicit intent across both adapters without derived metadata", () => {
    const model = {
      ...source.models[0]!,
      reasoningOverride: {
        supported: true,
        levels: ["low", "high"] as const,
        defaultLevel: "high" as const,
      },
    };
    expect(effectiveCustomModelReasoning(model, source.protocol)).toEqual({
      status: "known",
      supported: true,
      levels: ["low", "high"],
      defaultLevel: "high",
      mode: "effort",
    });
    expect(piCustomModelReasoning(model, source.protocol)).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { low: "low", high: "high", medium: null },
    });
    expect(
      buildDroidCustomModelsSettings([{ ...source, models: [model], apiKey: null }]).settings
        .customModels[0],
    ).toMatchObject({ enableThinking: true, reasoningEffort: "high" });
    expect(effectiveCustomModelReasoning(source.models[0]!, source.protocol)).toBeUndefined();
  });
  it("never lets old discovery override an explicit nonreasoning declaration", () => {
    const model = {
      ...source.models[0]!,
      reasoningMetadata: {
        status: "known" as const,
        source: "provider" as const,
        stale: true,
        checkedAt: "2026-09-06T00:00:00Z",
        supported: true,
        levels: ["high"] as const,
      },
      reasoningOverride: { supported: false, levels: [] },
    };
    expect(effectiveCustomModelReasoning(model, source.protocol)?.supported).toBe(false);
    expect(
      buildDroidCustomModelsSettings([{ ...source, models: [model], apiKey: null }]).settings
        .customModels[0],
    ).toMatchObject({ enableThinking: false });
  });
  it("scopes discovery invalidation to relevant model facts, without timestamps or secrets", () => {
    const metadata = {
      status: "known" as const,
      source: "provider" as const,
      stale: false,
      checkedAt: "2026-09-06T00:00:00Z",
      supported: true,
      levels: ["high"] as const,
    };
    const original = { ...source, models: [{ ...source.models[0]!, reasoningMetadata: metadata }] };
    const before = customModelDiscoverySnapshot([original], instanceId);
    expect(
      customModelDiscoverySnapshot(
        [
          {
            ...original,
            models: [
              {
                ...original.models[0]!,
                instanceIds: [instanceId, ProviderInstanceId.make("droid")],
                reasoningMetadata: { ...metadata, checkedAt: "2026-09-06T01:00:00Z", stale: true },
              },
            ],
          },
          { ...source, id: "unrelated", models: [] },
        ],
        instanceId,
      ),
    ).toEqual(before);
    for (const updated of [
      { ...original, credentialId: "rotated" },
      { ...original, models: [{ ...original.models[0]!, name: "Renamed" }] },
      {
        ...original,
        models: [{ ...original.models[0]!, reasoningOverride: { supported: false, levels: [] } }],
      },
      { ...original, models: [] },
    ])
      expect(customModelDiscoverySnapshot([updated], instanceId)).not.toEqual(before);
  });
});
