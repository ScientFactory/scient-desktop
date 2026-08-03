// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter model discovery respects auth and SDK-supported thinking levels.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  getPiDiscoverableModels,
  getPiSupportedThinkingOptions,
  makePiUserInputOptions,
  PLAIN_PI_EXTENSION_THEME,
  toPiProviderModelDescriptor,
} from "./PiAdapter";

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiDiscoverableModels", () => {
  it("preserves valid Pi model identities and metadata", () => {
    const descriptor = toPiProviderModelDescriptor(
      {
        provider: "openrouter",
        id: "google/gemma-4-26b-a4b-it",
        name: "Google: Gemma 4 26B A4B",
        reasoning: false,
      } as Model<Api>,
      () => "OpenRouter",
    );

    expect(descriptor).toEqual({
      slug: "openrouter/google/gemma-4-26b-a4b-it",
      name: "Google: Gemma 4 26B A4B",
      upstreamProviderId: "openrouter",
      upstreamProviderName: "OpenRouter",
    });
  });

  it("trims extension-owned display metadata", () => {
    const descriptor = toPiProviderModelDescriptor(
      {
        provider: "openrouter",
        id: "google/gemma-4-26b-a4b-it",
        name: " Google: Gemma 4 26B A4B ",
        reasoning: false,
      } as Model<Api>,
      () => " OpenRouter ",
    );

    expect(descriptor).toMatchObject({
      slug: "openrouter/google/gemma-4-26b-a4b-it",
      name: "Google: Gemma 4 26B A4B",
      upstreamProviderId: "openrouter",
      upstreamProviderName: "OpenRouter",
    });
  });

  it("falls back from blank display metadata without dropping a valid model", () => {
    const descriptor = toPiProviderModelDescriptor(
      {
        provider: "local",
        id: "glm-5.2",
        name: "   ",
        reasoning: false,
      } as Model<Api>,
      () => "\t",
    );

    expect(descriptor).toMatchObject({
      slug: "local/glm-5.2",
      name: "local/glm-5.2",
      upstreamProviderId: "local",
      upstreamProviderName: "local",
    });
  });

  it("omits models with blank registry identities", () => {
    expect(
      toPiProviderModelDescriptor(
        { provider: "", id: "model-id", name: "Model", reasoning: false } as Model<Api>,
        () => "Provider",
      ),
    ).toBeNull();
    expect(
      toPiProviderModelDescriptor(
        { provider: "provider", id: "   ", name: "Model", reasoning: false } as Model<Api>,
        () => "Provider",
      ),
    ).toBeNull();
  });

  it("omits models whose trimmed identity would no longer resolve in Pi", () => {
    expect(
      toPiProviderModelDescriptor(
        { provider: " openrouter", id: "model-id", name: "Model", reasoning: false } as Model<Api>,
        () => "OpenRouter",
      ),
    ).toBeNull();
    expect(
      toPiProviderModelDescriptor(
        { provider: "openrouter", id: " model-id", name: "Model", reasoning: false } as Model<Api>,
        () => "OpenRouter",
      ),
    ).toBeNull();
  });

  it("preserves supported thinking metadata", () => {
    const descriptor = toPiProviderModelDescriptor(
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh" },
      } as Model<Api>,
      () => "Anthropic",
    );

    expect(descriptor?.supportedReasoningEfforts?.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(descriptor?.defaultReasoningEffort).toBe("medium");
  });

  it("includes custom-provider models authenticated through auth.json semantics", () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-models-"));
    const modelsPath = path.join(agentDir, "models.json");

    try {
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            local: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [{ id: "glm-5.2" }],
            },
          },
        }),
      );
      const authStorage = AuthStorage.inMemory({
        local: { type: "api_key", key: "test-key" },
      });
      const registry = ModelRegistry.create(authStorage, modelsPath);

      const models = getPiDiscoverableModels(registry);

      expect(models.some((model) => model.provider === "local" && model.id === "glm-5.2")).toBe(
        true,
      );
      expect(models.some((model) => model.provider === "anthropic")).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh only when the concrete Pi model supports it", () => {
    const withoutXHigh = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );

    expect(withoutXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("Pi extension UI helpers", () => {
  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});
