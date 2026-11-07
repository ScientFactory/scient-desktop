import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getPromptControlledTraits,
  getTraitSelectChange,
  readPromptUltrathink,
} from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("pi"),
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });
});

const effort: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("prompt-controlled traits", () => {
  // regression: 29f4ebb106 chore(upstream): align with t3code 2c8bdf6177
  it.each([
    ["Fix the bug", "none"],
    ["Ultrathink: Fix the bug", "prefix"],
    ["ultrathink about the bug", "body"],
    ["Ultrathink: ultrathink harder", "body"],
    ["uLtRaThInK:\nFix the bug", "prefix"],
    ["Ultrathink:\n", "prefix"],
    ["Ultrathinking", "none"],
    [" UlTrAtHiNk: Fix the bug", "body"],
  ] as const)(
    "shares the %s classification with the descriptor-controlled view",
    (prompt, state) => {
      expect(readPromptUltrathink(prompt)).toBe(state);
      expect(getPromptControlledTraits([effort], prompt)).toEqual({
        primarySelectDescriptor: effort,
        ultrathinkPromptControlled: state !== "none",
        ultrathinkInBodyText: state === "body",
      });
    },
  );

  it("requires admission by the primary descriptor and the prompt-injection gate", () => {
    const regular = { ...effort, promptInjectedValues: [] };
    for (const selected of [
      getPromptControlledTraits([], "Ultrathink: solve it"),
      getPromptControlledTraits([regular, effort], "Ultrathink: solve it"),
      getPromptControlledTraits([effort], "please ultrathink", false),
    ]) {
      expect(selected.ultrathinkPromptControlled).toBe(false);
      expect(selected.ultrathinkInBodyText).toBe(false);
    }
  });

  it("edits the live prompt rather than replacing it with its render snapshot", () => {
    const selected = {
      ...getPromptControlledTraits([effort], "Ultrathink:\nold draft"),
      descriptors: [effort],
    };
    expect(getTraitSelectChange(selected, effort, "Ultrathink:\nnew draft", "low")).toEqual({
      prompt: "new draft",
      modelOptions: [{ id: "effort", value: "low" }],
    });
  });

  it.each(["please ultrathink", "Ultrathink:\nplease ultrathink"])(
    "does not remove body-controlled reasoning from %s",
    (prompt) => {
      const selected = {
        ...getPromptControlledTraits([effort], prompt),
        descriptors: [effort],
      };
      expect(getTraitSelectChange(selected, effort, prompt, "low")).toBeNull();
    },
  );
});
