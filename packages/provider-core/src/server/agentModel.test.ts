import { describe, expect, it } from "vite-plus/test";

import {
  encodeAgentModelSlug,
  isValidModelSegment,
  reasoningLevelLabel,
  splitAgentModelSlug,
  thinkingLevelCapabilities,
} from "./agentModel.ts";

describe("provider/model slug helpers", () => {
  it("encodes and splits a canonical model slug", () => {
    expect(encodeAgentModelSlug("anthropic", "claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
    expect(encodeAgentModelSlug("google", "models/gemini")).toBe("google/models%2Fgemini");
    expect(splitAgentModelSlug("anthropic/claude-opus-4-6")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(splitAgentModelSlug("google/models%2Fgemini")).toEqual({
      provider: "google",
      modelId: "models/gemini",
    });
  });

  it("rejects malformed or ambiguous slugs", () => {
    expect(encodeAgentModelSlug("", "model")).toBeUndefined();
    expect(encodeAgentModelSlug(" provider", "model")).toBeUndefined();
    expect(splitAgentModelSlug("provider")).toBeUndefined();
    expect(splitAgentModelSlug("a/b/c")).toBeUndefined();
    expect(splitAgentModelSlug("/leading")).toBeUndefined();
    expect(splitAgentModelSlug("%E0%A4%A/x")).toBeUndefined();
  });

  it("projects reasoning levels with the shared labels and defaults", () => {
    expect(isValidModelSegment("claude-opus-4-6")).toBe(true);
    expect(isValidModelSegment(" claude")).toBe(false);
    expect(reasoningLevelLabel("xhigh")).toBe("Extra-high");
    expect(reasoningLevelLabel("minimal")).toBe("Minimal");
    expect(thinkingLevelCapabilities(["low", "high"], "high").optionDescriptors).toEqual([
      {
        id: "thinkingLevel",
        label: "Reasoning",
        type: "select",
        strictSelection: true,
        concreteReasoning: true,
        emptySelectionLabel: "Reasoning",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ]);
  });
});
