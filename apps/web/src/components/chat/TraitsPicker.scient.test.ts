import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";
import { getProviderOptionDescriptors, getProviderOptionCurrentValue } from "@t3tools/shared/model";
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
  // regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
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
    expect(display([descriptor]).label).toBe("Reasoning unknown");
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

const CODEX = ProviderDriverKind.make("codex");
function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

// regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
it.each([true, false])(
  "shows unavailable strict saved effort without selecting a valid choice (empty: %s)",
  (empty) => {
    const descriptors = getProviderOptionDescriptors({
      caps: {
        optionDescriptors: [
          {
            id: "thinking",
            label: "Reasoning",
            type: "select",
            strictSelection: true,
            options: empty
              ? []
              : [
                  {
                    id: "default",
                    label: "Default (Medium)",
                    isDefault: true,
                  },
                ],
          },
        ],
      },
      selections: [
        {
          id: "thinking",
          value: "max",
        },
      ],
    });
    expect(display(descriptors).label).toBe("max unavailable");
    const descriptor = descriptors[0];
    expect(
      descriptor?.type === "select" &&
        descriptor.options.some(
          (option) => option.id === getProviderOptionCurrentValue(descriptor),
        ),
    ).toBe(false);
  },
);

// regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
it.each([undefined, "Reasoning unknown", "Reasoning unavailable"])(
  "displays the provider empty selection label %s for strict reasoning",
  (emptySelectionLabel) => {
    for (const options of [
      [],
      [
        {
          id: "medium",
          label: "Medium",
        },
      ],
    ]) {
      const descriptor: ProviderOptionDescriptor = {
        id: "thinking",
        label: "Reasoning",
        type: "select",
        strictSelection: true,
        options,
        ...(emptySelectionLabel
          ? {
              emptySelectionLabel,
            }
          : {}),
      };
      expect(display([descriptor]).label).toBe(emptySelectionLabel ?? "Default");
      expect(getProviderOptionCurrentValue(descriptor)).toBeUndefined();
    }
  },
);

// regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
it.each(["Default", "Default (Medium)"])(
  "renders the strict provider default label %s",
  (label) => {
    expect(
      display([
        {
          id: "thinking",
          label: "Reasoning",
          type: "select",
          strictSelection: true,
          options: [
            {
              id: "default",
              label,
              isDefault: true,
            },
          ],
        },
      ]).label,
    ).toBe(label);
  },
);
