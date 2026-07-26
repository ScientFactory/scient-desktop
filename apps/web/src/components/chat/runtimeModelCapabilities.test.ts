import { describe, expect, it } from "vitest";

import {
  getRuntimeAwareModelCapabilities,
  resolveRuntimeModelDescriptor,
} from "./runtimeModelCapabilities";

describe("Claude runtime model capabilities", () => {
  it("matches an older moving alias by the SDK-resolved model identity", () => {
    const runtimeModels = [
      {
        slug: "opus[1m]",
        name: "Opus",
        resolvedModel: "claude-opus-4-8[1m]",
        supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
        supportsFastMode: false,
      },
    ];

    const runtimeModel = resolveRuntimeModelDescriptor({
      provider: "claudeAgent",
      model: "claude-opus-4-8",
      runtimeModels,
    });

    expect(runtimeModel).toBe(runtimeModels[0]);
    const capabilities = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: "claude-opus-4-8",
      runtimeModel,
    });
    expect(capabilities.reasoningEffortLevels.map((effort) => effort.value)).toEqual([
      "low",
      "high",
      "ultrathink",
      "ultracode",
    ]);
    expect(capabilities.supportsFastMode).toBe(false);
  });

  it("matches Opus 5 after the same moving alias advances", () => {
    const runtimeModel = {
      slug: "opus[1m]",
      name: "Opus",
      resolvedModel: "claude-opus-5[1m]",
      supportedReasoningEfforts: [{ value: "xhigh" }],
      supportsFastMode: true,
    };

    const resolvedRuntimeModel = resolveRuntimeModelDescriptor({
      provider: "claudeAgent",
      model: "claude-opus-5",
      runtimeModels: [runtimeModel],
    });

    expect(resolvedRuntimeModel).toBe(runtimeModel);
    const capabilities = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: "claude-opus-5",
      runtimeModel: resolvedRuntimeModel,
    });
    expect(capabilities.reasoningEffortLevels.map((effort) => effort.value)).toEqual([
      "xhigh",
      "ultracode",
    ]);
    expect(capabilities.supportsFastMode).toBe(true);
  });

  it("treats explicit runtime capability denial as authoritative", () => {
    const capabilities = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: "claude-opus-4-8",
      runtimeModel: {
        slug: "opus",
        name: "Opus",
        resolvedModel: "claude-opus-4-8",
        supportsReasoningEffort: false,
        supportedReasoningEfforts: [],
        supportsThinkingToggle: false,
      },
    });

    expect(capabilities.reasoningEffortLevels).toEqual([]);
    expect(capabilities.supportsThinkingToggle).toBe(false);
  });

  it("exposes runtime capabilities for a model absent from the static catalog", () => {
    const capabilities = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: "claude-future-1",
      runtimeModel: {
        slug: "future",
        name: "Claude Future",
        resolvedModel: "claude-future-1",
        supportsReasoningEffort: true,
        supportedReasoningEfforts: [{ value: "high" }],
        supportsThinkingToggle: true,
      },
    });

    expect(capabilities.reasoningEffortLevels.map((effort) => effort.value)).toEqual(["high"]);
    expect(capabilities.supportsThinkingToggle).toBe(true);
  });
});
