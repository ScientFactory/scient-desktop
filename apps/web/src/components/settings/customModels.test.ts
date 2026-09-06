import { describe, expect, it } from "vite-plus/test";
import type { ModelConnectionReadiness, ServerProvider } from "@t3tools/contracts";
import { CUSTOM_MODEL_PRESETS, customModelPresetId, modelConnectionStatus } from "./customModels";

const provider = {
  enabled: true,
  installed: true,
  probePending: false,
  status: "ready",
  auth: { status: "unknown" },
} satisfies Pick<ServerProvider, "enabled" | "installed" | "probePending" | "status" | "auth">;
const available: ModelConnectionReadiness = {
  connectionId: "c",
  modelId: "m",
  configurationKey: "key",
  state: "available",
  source: "agent",
};

describe("model connection presentation", () => {
  it("does not confuse unreported limits with an unavailable agent-native model", () => {
    expect(modelConnectionStatus(provider, available)).toBeUndefined();
    expect(modelConnectionStatus(provider, { ...available, state: "needs_setup" })).toBe(
      "Needs setup",
    );
    expect(modelConnectionStatus(provider, undefined)).toBe("Checking");
    expect(modelConnectionStatus({ ...provider, probePending: true }, available)).toBe("Checking");
  });
  it("distinguishes installation, disabled, authentication and probe failures", () => {
    expect(modelConnectionStatus({ ...provider, enabled: false }, available)).toBe("Disabled");
    expect(modelConnectionStatus({ ...provider, installed: false }, undefined)).toBe(
      "Not installed",
    );
    expect(modelConnectionStatus({ ...provider, status: "error" }, undefined)).toBe("Check agent");
    expect(modelConnectionStatus({ ...provider, status: "error" }, available)).toBe("Check agent");
    expect(
      modelConnectionStatus({ ...provider, auth: { status: "unauthenticated" } }, undefined),
    ).toBe("Check agent");
  });
  it("uses xAI Responses for new connections without rewriting saved completions", () => {
    expect(CUSTOM_MODEL_PRESETS.find((preset) => preset.id === "spacexai")?.protocol).toBe(
      "openai-responses",
    );
    const saved = {
      id: "xai",
      name: "SpaceXAI",
      protocol: "openai-completions" as const,
      baseUrl: "https://api.x.ai/v1",
      credentialId: null,
      models: [],
    };
    expect(customModelPresetId(saved)).toBe("spacexai");
    expect(saved.protocol).toBe("openai-completions");
  });
});
