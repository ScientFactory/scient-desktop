import { describe, expect, it } from "vite-plus/test";
import { type ModelCapabilities } from "@t3tools/contracts";
import {
  preferredReasoningLevel,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  getProviderOptionCurrentValue,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

it("uses an enabled user preference without changing provider defaults or accepting unsupported levels", () => {
  const levels = ["low", "medium", "high"];
  expect(preferredReasoningLevel(levels, "medium", "high")).toBe("high");
  expect(preferredReasoningLevel(levels, "medium", "max")).toBe("medium");
  expect(preferredReasoningLevel(levels, "medium", "off")).toBe("medium");
  expect(preferredReasoningLevel([], "medium", "high")).toBeUndefined();
  expect(preferredReasoningLevel(levels, "medium")).toBe("medium");
});

it("keeps explicit conversation effort when the model's default changes", () => {
  const caps = createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinkingLevel",
        label: "Reasoning",
        type: "select",
        concreteReasoning: true,
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
  });
  const selections = [{ id: "thinkingLevel", value: "medium" }];
  const descriptors = getProviderOptionDescriptors({ caps, selections });
  expect(getProviderOptionCurrentValue(descriptors[0])).toBe("medium");
  expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections)).toEqual(
    selections,
  );
  const fresh = getProviderOptionDescriptors({ caps });
  expect(buildExplicitProviderOptionSelectionsFromDescriptors(fresh, undefined)).toEqual([
    { id: "thinkingLevel", value: "high" },
  ]);
});

it("keeps Off when a concrete reasoning control offers it, and never invents it", () => {
  const caps = (options: ReadonlyArray<{ id: string; label: string; isDefault?: true }>) =>
    createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          concreteReasoning: true,
          options: [...options],
        },
      ],
    });
  const selections = [{ id: "reasoningEffort", value: "off" }];
  const offered = getProviderOptionDescriptors({
    caps: caps([
      { id: "off", label: "Off" },
      { id: "high", label: "High", isDefault: true },
    ]),
    selections,
  });
  expect(getProviderOptionCurrentValue(offered[0])).toBe("off");
  expect(buildExplicitProviderOptionSelectionsFromDescriptors(offered, selections)).toEqual(
    selections,
  );
  // Not offered: a saved Off falls back to the default level, as before.
  const notOffered = getProviderOptionDescriptors({
    caps: caps([{ id: "high", label: "High", isDefault: true }]),
    selections,
  });
  expect(getProviderOptionCurrentValue(notOffered[0])).toBe("high");
  // With no saved choice the default is still a level, never Off.
  const fresh = getProviderOptionDescriptors({
    caps: caps([
      { id: "off", label: "Off" },
      { id: "high", label: "High" },
    ]),
  });
  expect(getProviderOptionCurrentValue(fresh[0])).toBe("high");
});

describe("descriptor helpers", () => {
  it.each([true, false])(
    "preserves strict unavailable selections with an empty catalog: %s",
    (empty) => {
      const caps = createModelCapabilities({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Reasoning",
            type: "select",
            strictSelection: true,
            options: empty ? [] : [{ id: "default", label: "Default (Medium)", isDefault: true }],
          },
        ],
      });
      const selections = [{ id: "thinking", value: "max" }];
      const descriptors = getProviderOptionDescriptors({ caps, selections });
      expect(getProviderOptionCurrentValue(descriptors[0])).toBe("max");
      expect(getProviderOptionCurrentLabel(descriptors[0])).toBe("max unavailable");
      expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections)).toEqual(
        selections,
      );
      expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual(selections);
    },
  );

  it("keeps strict reasoning unset and preserves known default labels", () => {
    for (const options of [[], [{ id: "default", label: "Default (Medium)", isDefault: true }]]) {
      const descriptors = getProviderOptionDescriptors({
        caps: createModelCapabilities({
          optionDescriptors: [
            { id: "thinking", label: "Reasoning", type: "select", strictSelection: true, options },
          ],
        }),
      });
      expect(getProviderOptionCurrentLabel(descriptors[0])).toBe(
        options.length ? "Default (Medium)" : "Default",
      );
      expect(getProviderOptionCurrentValue(descriptors[0])).toBe(
        options.length ? "default" : undefined,
      );
      expect(
        buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined),
      ).toBeUndefined();
    }
  });

  // regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
  it.each([undefined, "Reasoning unknown", "Reasoning unavailable"])(
    "uses the strict empty selection label %s without inventing a value",
    (emptySelectionLabel) => {
      for (const options of [[], [{ id: "medium", label: "Medium" }]]) {
        const descriptors = getProviderOptionDescriptors({
          caps: {
            optionDescriptors: [
              {
                id: "thinking",
                label: "Reasoning",
                type: "select",
                strictSelection: true,
                options,
                ...(emptySelectionLabel ? { emptySelectionLabel } : {}),
              },
            ],
          },
        });
        expect(getProviderOptionCurrentLabel(descriptors[0])).toBe(
          emptySelectionLabel ?? "Default",
        );
        expect(getProviderOptionCurrentValue(descriptors[0])).toBeUndefined();
        expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toBeUndefined();
        expect(
          buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined),
        ).toBeUndefined();
      }
    },
  );

  it("retains fallback behavior for non-strict saved choices", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "reasoningEffort", value: "invalid" }],
    });
    expect(getProviderOptionCurrentValue(descriptors[0])).toBe("high");
    expect(getProviderOptionCurrentLabel(descriptors[0])).toBe("High");
  });
});
