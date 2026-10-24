import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveStaleDraftDefaultModelSelection } from "./chatThreadActions";

// regression: 67ab5e432f fix(settings): keep the default model's reasoning effort as chosen (#394)
describe("resolveStaleDraftDefaultModelSelection", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const lowDefault: ModelSelection = {
    instanceId: codex,
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const seededHigh = {
    activeProvider: codex,
    modelSelectionByProvider: {
      [codex]: { ...lowDefault, options: [{ id: "reasoningEffort", value: "high" }] },
    },
  };

  it("moves an unpicked draft to a default whose effort changed", () => {
    expect(resolveStaleDraftDefaultModelSelection(seededHigh, lowDefault)).toBe(lowDefault);
  });

  it("moves an unpicked draft to a default on another provider", () => {
    const claudeDefault = { instanceId: claude, model: "claude-opus-4-8" };
    expect(resolveStaleDraftDefaultModelSelection(seededHigh, claudeDefault)).toBe(claudeDefault);
  });

  it("leaves a draft that already uses the default alone", () => {
    const seeded = {
      activeProvider: codex,
      modelSelectionByProvider: {
        [codex]: {
          instanceId: codex,
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      },
    };
    expect(resolveStaleDraftDefaultModelSelection(seeded, lowDefault)).toBeNull();
  });

  it("never overrides a human pick", () => {
    expect(
      resolveStaleDraftDefaultModelSelection(
        { ...seededHigh, modelSelectionExplicit: true },
        lowDefault,
      ),
    ).toBeNull();
  });

  it("does nothing without a saved default or a draft", () => {
    expect(resolveStaleDraftDefaultModelSelection(seededHigh, null)).toBeNull();
    expect(resolveStaleDraftDefaultModelSelection(undefined, lowDefault)).toBeNull();
  });
});
