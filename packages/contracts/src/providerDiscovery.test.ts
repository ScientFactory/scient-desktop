import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderListAgentsInput,
  ProviderListModelsInput,
  ProviderListModelsResult,
} from "./providerDiscovery";

const decodeProviderListModelsResult = Schema.decodeUnknownSync(ProviderListModelsResult);

describe("ProviderListModelsResult", () => {
  it("preserves optional runtime model descriptions", () => {
    const result = decodeProviderListModelsResult({
      models: [
        {
          slug: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: "0.4x Factory token rate",
        },
        {
          slug: "custom:GPT-5.6-Luna-0",
          name: "GPT-5.6 Luna",
        },
      ],
      source: "droid-acp",
      runtimeVersion: "2.1.219",
    });

    expect(result.models[0]?.description).toBe("0.4x Factory token rate");
    expect(result.models[1]?.description).toBeUndefined();
    expect(result.runtimeVersion).toBe("2.1.219");
  });

  it("preserves explicit runtime capability support and denial", () => {
    const result = decodeProviderListModelsResult({
      models: [
        {
          slug: "runtime-supported",
          name: "Runtime supported",
          supportsReasoningEffort: true,
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
          supportsThinkingToggle: true,
        },
        {
          slug: "runtime-disabled",
          name: "Runtime disabled",
          supportsReasoningEffort: false,
          supportedReasoningEfforts: [],
          supportsThinkingToggle: false,
        },
      ],
      source: "sdk",
    });

    expect(result.models[0]?.supportsReasoningEffort).toBe(true);
    expect(result.models[0]?.supportsThinkingToggle).toBe(true);
    expect(result.models[1]?.supportsReasoningEffort).toBe(false);
    expect(result.models[1]?.supportedReasoningEfforts).toEqual([]);
    expect(result.models[1]?.supportsThinkingToggle).toBe(false);
  });
});

describe("Claude provider discovery generation", () => {
  it("preserves the auth/runtime generation on model and agent inputs", () => {
    const modelInput = Schema.decodeUnknownSync(ProviderListModelsInput)({
      provider: "claudeAgent",
      cwd: "/repo",
      discoveryGeneration: "authenticated-user-a",
    });
    const agentInput = Schema.decodeUnknownSync(ProviderListAgentsInput)({
      provider: "claudeAgent",
      cwd: "/repo",
      discoveryGeneration: "authenticated-user-a",
    });

    expect(modelInput.discoveryGeneration).toBe("authenticated-user-a");
    expect(agentInput.discoveryGeneration).toBe("authenticated-user-a");
  });
});
