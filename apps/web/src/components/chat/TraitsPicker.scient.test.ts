import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { shouldRenderTraitsControls, withoutPromptInjectedOptions } from "./TraitsPicker";

const CONTEXT_WINDOW: ProviderOptionDescriptor = {
  id: "contextWindow",
  label: "contextWindow",
  type: "select",
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  currentValue: "1m",
};
const FAST_MODE: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast Mode",
  type: "boolean",
  currentValue: true,
};

describe("shouldRenderTraitsControls", () => {
  // Labels for strict selections are covered in packages/shared/src/model.test.ts.
  it("keeps unknown strict reasoning visible without inventing an effort", () => {
    const descriptor: ProviderOptionDescriptor = {
      id: "thinking",
      label: "Reasoning",
      type: "select",
      strictSelection: true,
      options: [],
      emptySelectionLabel: "Reasoning unknown",
      description: "Reasoning settings unknown...",
    };
    expect(
      shouldRenderTraitsControls({
        provider: ProviderDriverKind.make("pi"),
        model: "custom",
        models: [
          {
            slug: "custom",
            name: "Custom",
            isCustom: false,
            capabilities: {
              optionDescriptors: [descriptor],
            },
          },
        ],
        modelOptions: undefined,
        promptUltrathink: "none",
        planModeEnabled: false,
      }),
    ).toBe(true);
  });
});
describe("withoutPromptInjectedOptions", () => {
  // regression: 67ab5e432f fix(settings): keep the default model's reasoning effort as chosen (#394)
  it("removes ultrathink but keeps every real effort and the saved value", () => {
    const effort: ProviderOptionDescriptor = {
      id: "effort",
      label: "Effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "low",
      promptInjectedValues: ["ultrathink"],
    };
    const [filtered] = withoutPromptInjectedOptions([effort, CONTEXT_WINDOW, FAST_MODE]);
    expect(filtered).toMatchObject({
      currentValue: "low",
    });
    expect(filtered?.type === "select" && filtered.options.map((option) => option.id)).toEqual([
      "low",
      "high",
    ]);
    expect(withoutPromptInjectedOptions([CONTEXT_WINDOW])[0]).toBe(CONTEXT_WINDOW);
  });
});
