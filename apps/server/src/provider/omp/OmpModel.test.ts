import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { OmpRpcAvailableModels } from "effect-omp-rpc/schema";

import {
  decodeOmpModelSlug,
  encodeOmpModelSlug,
  ompModelSupportsImages,
  ompModelThinkingLevels,
  ompModelToServerModel,
  ompThinkingLevel,
} from "./OmpModel.ts";

const decodeModels = Schema.decodeUnknownSync(OmpRpcAvailableModels);

const reasoningOptions = (model: ReturnType<typeof ompModelToServerModel>) => {
  const descriptor = model?.capabilities?.optionDescriptors?.[0];
  return descriptor && "options" in descriptor
    ? descriptor.options.map((option) => ({
        id: option.id,
        ...(option.isDefault ? { isDefault: true } : {}),
      }))
    : [];
};

describe("Oh My Pi model slugs", () => {
  it("round-trips a provider and model id", () => {
    const slug = encodeOmpModelSlug("openai", "gpt-5");
    expect(slug).toBe("openai/gpt-5");
    expect(decodeOmpModelSlug(slug ?? "")).toEqual({ provider: "openai", modelId: "gpt-5" });
  });

  it("accepts native model ids containing reserved characters", () => {
    expect(decodeOmpModelSlug("ollama/gemma4:12b-it-qat")).toEqual({
      provider: "ollama",
      modelId: "gemma4:12b-it-qat",
    });
  });

  it("rejects a slug that is not one canonical segment pair", () => {
    expect(decodeOmpModelSlug("openai")).toBeUndefined();
    expect(decodeOmpModelSlug("openai/gpt/5")).toBeUndefined();
    expect(decodeOmpModelSlug("openai/gpt-5 ")).toBeUndefined();
    expect(encodeOmpModelSlug(" open", "gpt-5")).toBeUndefined();
  });

  it("uses the model input capability rather than guessing image support", () => {
    expect(ompModelSupportsImages({ provider: "ollama", id: "text", input: ["text"] })).toBe(false);
    expect(
      ompModelSupportsImages({ provider: "ollama", id: "image", input: ["text", "image"] }),
    ).toBe(true);
    expect(ompModelSupportsImages({ provider: "ollama", id: "unknown" })).toBe(false);
  });

  it("keeps only known thinking levels and exposes them as a reasoning option", () => {
    expect(ompThinkingLevel("xhigh")).toBe("xhigh");
    expect(ompThinkingLevel("turbo")).toBeUndefined();
    const model = ompModelToServerModel({
      provider: "anthropic",
      id: "claude",
      reasoning: true,
      thinkingLevels: ["low", "mystery", "high"],
    });
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(model?.slug).toBe("anthropic/claude");
    expect(descriptor?.id).toBe("thinkingLevel");
    expect(
      descriptor && "options" in descriptor ? descriptor.options.map((option) => option.id) : [],
    ).toEqual(["low", "high"]);
  });

  it("M-1 lists exactly the efforts Oh My Pi reports, with its default", () => {
    // Shape recorded from omp 18.3.1 `get_available_models` (available-models capture).
    const [model] = decodeModels({
      models: [
        {
          provider: "scient-stub",
          id: "stub-reasoning",
          reasoning: true,
          thinking: {
            mode: "effort",
            efforts: ["low", "medium", "high"],
            defaultLevel: "low",
            requiresEffort: true,
          },
        },
      ],
    }).models;
    expect(ompModelThinkingLevels(model!)).toEqual(["low", "medium", "high"]);
    expect(reasoningOptions(ompModelToServerModel(model!))).toEqual([
      { id: "low", isDefault: true },
      { id: "medium" },
      { id: "high" },
    ]);
  });

  it("M-2 shows no selector for a reasoning model without thinking metadata", () => {
    const model = { provider: "vendor", id: "reasoner", reasoning: true };
    expect(ompModelThinkingLevels(model)).toEqual([]);
    expect(ompModelToServerModel(model)?.capabilities).toBeNull();
    // A non-reasoning model never offers levels, even if efforts were sent.
    expect(
      ompModelThinkingLevels({
        provider: "vendor",
        id: "plain",
        reasoning: false,
        thinking: { efforts: ["low"] },
      }),
    ).toEqual([]);
  });

  it("M-3 never adds max to an Opus-style five-level list", () => {
    const model = {
      provider: "anthropic",
      id: "claude-opus-4-0",
      reasoning: true,
      thinking: {
        mode: "budget",
        efforts: ["minimal", "low", "medium", "high", "xhigh"],
      },
    };
    const options = reasoningOptions(ompModelToServerModel(model)).map((option) => option.id);
    expect(options).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(options).not.toContain("max");
    // Without an Oh My Pi default, the shared preference picks one.
    expect(reasoningOptions(ompModelToServerModel(model))).toContainEqual({
      id: "medium",
      isDefault: true,
    });
  });

  it("M-4 decodes thinking metadata and tolerates unknown level strings", () => {
    const [model] = decodeModels({
      models: [
        {
          provider: "vendor",
          id: "future",
          reasoning: true,
          thinking: { mode: "effort", efforts: ["low", "turbo", "high"], defaultLevel: "turbo" },
        },
      ],
    }).models;
    expect(model?.thinking?.efforts).toEqual(["low", "turbo", "high"]);
    expect(ompModelThinkingLevels(model!)).toEqual(["low", "high"]);
    // An unknown default falls back to the shared preference.
    expect(reasoningOptions(ompModelToServerModel(model!))).toEqual([
      { id: "low" },
      { id: "high", isDefault: true },
    ]);
  });

  it("uses the legacy thinkingLevels list only when thinking is absent", () => {
    expect(
      ompModelThinkingLevels({
        provider: "vendor",
        id: "legacy",
        reasoning: true,
        thinkingLevels: ["off", "low", "high"],
      }),
    ).toEqual(["low", "high"]);
    expect(
      ompModelThinkingLevels({
        provider: "vendor",
        id: "both",
        reasoning: true,
        thinking: { efforts: ["high"] },
        thinkingLevels: ["low", "high"],
      }),
    ).toEqual(["high"]);
  });
});
