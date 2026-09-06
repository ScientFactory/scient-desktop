import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  preferredReasoningLevel,
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  readCustomModelEntries,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "./model.ts";

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

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
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

  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("writes the compact stored shape back", () => {
    expect(toCustomModelSetting({ slug: "x", name: "x", capabilities: null })).toBe("x");
    expect(
      toCustomModelSetting({ slug: "x", name: "x", capabilities: { optionDescriptors: [] } }),
    ).toBe("x");
    expect(toCustomModelSetting({ slug: "x", name: "X", capabilities })).toEqual({
      slug: "x",
      name: "X",
      capabilities,
    });
  });
});
