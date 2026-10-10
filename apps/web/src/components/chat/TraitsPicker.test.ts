import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  buildUnavailableModelOptionDescriptors,
  shouldRenderTraitsControls,
  withoutPromptInjectedOptions,
} from "./TraitsPicker";
import { getProviderOptionDescriptors, getProviderOptionCurrentValue } from "@t3tools/shared/model";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "ultrafast" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
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
              options: empty ? [] : [{ id: "default", label: "Default (Medium)", isDefault: true }],
            },
          ],
        },
        selections: [{ id: "thinking", value: "max" }],
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
            capabilities: { optionDescriptors: [descriptor] },
          },
        ],
        modelOptions: undefined,
        prompt: "",
        planModeEnabled: false,
      }),
    ).toBe(true);
  });

  it.each([undefined, "Reasoning unknown", "Reasoning unavailable"])(
    "displays the provider empty selection label %s for strict reasoning",
    (emptySelectionLabel) => {
      for (const options of [[], [{ id: "medium", label: "Medium" }]]) {
        const descriptor: ProviderOptionDescriptor = {
          id: "thinking",
          label: "Reasoning",
          type: "select",
          strictSelection: true,
          options,
          ...(emptySelectionLabel ? { emptySelectionLabel } : {}),
        };
        expect(display([descriptor]).label).toBe(emptySelectionLabel ?? "Default");
        expect(getProviderOptionCurrentValue(descriptor)).toBeUndefined();
      }
    },
  );

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
            options: [{ id: "default", label, isDefault: true }],
          },
        ]).label,
      ).toBe(label);
    },
  );

  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
    });
  });

  it("pairs fast mode with reasoning before the context window", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High Fast · 1M",
    });
    expect(display([EFFORT, CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({
      label: "High Fast · 1M",
    });
  });

  it.each(["reasoningEffort", "reasoning", "effort", "variant", "thinking"])(
    "pairs Fast with %s even when context is the primary select",
    (id) => {
      for (const speed of [fastModeDescriptor(true), serviceTierDescriptor("priority")]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: CODEX,
            descriptors: [
              selectDescriptor("profile", [{ id: "balanced", label: "Balanced" }], "balanced"),
              CONTEXT_WINDOW,
              { ...EFFORT, id },
              speed,
            ],
            primarySelectDescriptorId: "profile",
            ultrathinkPromptControlled: false,
          }),
        ).toEqual({ label: "Balanced · 1M · High Fast" });
      }
      expect(
        buildTraitsTriggerDisplay({
          provider: CODEX,
          descriptors: [CONTEXT_WINDOW, { ...EFFORT, id }, serviceTierDescriptor("ultrafast")],
          primarySelectDescriptorId: CONTEXT_WINDOW.id,
          ultrathinkPromptControlled: false,
        }),
      ).toEqual({ label: "1M · High Ultrafast" });
    },
  );

  it("pairs Cursor Fast with reasoning rather than the thinking toggle", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("cursor"),
        descriptors: [
          { ...EFFORT, id: "reasoning" },
          fastModeDescriptor(true),
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        ],
        primarySelectDescriptorId: "reasoning",
        ultrathinkPromptControlled: false,
      }),
    ).toEqual({ label: "High Fast · Thinking On" });
  });

  it.each([true, false])("keeps boolean thinking %s independent of Fast", (currentValue) => {
    const thinking = {
      id: "thinking",
      label: "Thinking",
      type: "boolean" as const,
      currentValue,
    };
    const label = `Thinking ${currentValue ? "On" : "Off"}`;
    expect(display([thinking, fastModeDescriptor(true)])).toEqual({ label: `${label} · Fast` });
    expect(display([thinking, { ...EFFORT, id: "reasoning" }, fastModeDescriptor(true)])).toEqual({
      label: `${label} · High Fast`,
    });
    expect(display([thinking, fastModeDescriptor(false)])).toEqual({ label });
  });

  it("keeps speed separate when there is no reasoning descriptor", () => {
    expect(display([CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({ label: "1M · Fast" });
  });

  it.each(["Low", "Medium", "High", "Extra High", "Max", "Ultra"])(
    "preserves %s reasoning with Fast across harnesses",
    (label) => {
      for (const provider of ["codex", "claudeAgent", "cursor"]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: ProviderDriverKind.make(provider),
            descriptors: [
              { ...EFFORT, options: [{ id: "effort", label }], currentValue: "effort" },
              fastModeDescriptor(true),
            ],
            primarySelectDescriptorId: EFFORT.id,
            ultrathinkPromptControlled: false,
          }),
        ).toEqual({ label: `${label} Fast` });
      }
    },
  );

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({ label: "High" });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({ label: "High Fast" });
  });

  it("keeps Codex Ultrafast distinct from Fast", () => {
    expect(display([EFFORT, serviceTierDescriptor("ultrafast")])).toEqual({
      label: "High Ultrafast",
    });
  });

  it("uses Ultrafast without requiring a Fast tier", () => {
    const descriptor = serviceTierDescriptor("ultrafast");
    expect(
      display([
        EFFORT,
        { ...descriptor, options: descriptor.options.filter(({ id }) => id !== "priority") },
      ]),
    ).toEqual({ label: "High Ultrafast" });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({ label: "High · Flex" });
  });

  it("keeps Standard as text for models without speed tiers", () => {
    const descriptor = serviceTierDescriptor("default");
    const nonSpeedDescriptor = {
      ...descriptor,
      options: descriptor.options.filter(({ id }) => id === "default" || id === "flex"),
    };
    expect(display([EFFORT, nonSpeedDescriptor])).toEqual({ label: "High · Standard" });
    expect(display([nonSpeedDescriptor])).toEqual({ label: "Standard" });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({ label: "Standard" });
    expect(display([serviceTierDescriptor("priority")])).toEqual({ label: "Fast" });
  });

  it("keeps Ultrafast readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("ultrafast")])).toEqual({ label: "Ultrafast" });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({ label: "High · Thinking On" });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({ label: "Fast" });
    expect(display([fastModeDescriptor(false)])).toEqual({ label: "Normal" });
  });

  it("does not add Fast to a model without a speed option", () => {
    expect(display([EFFORT, CONTEXT_WINDOW])).toEqual({ label: "High · 1M" });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "" });
  });

  it("still renders prompt-controlled ultrathink with Fast", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink Fast" });
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  it("shows only saved values without inventing alternatives", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "variant", value: "max" },
        { id: "agent", value: "build" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: [{ id: "max", label: "max" }],
        currentValue: "max",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "build" }],
        currentValue: "build",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });
});

describe("withoutPromptInjectedOptions", () => {
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

    const [filtered] = withoutPromptInjectedOptions([
      effort,
      CONTEXT_WINDOW,
      fastModeDescriptor(true),
    ]);

    expect(filtered).toMatchObject({ currentValue: "low" });
    expect(filtered?.type === "select" && filtered.options.map((option) => option.id)).toEqual([
      "low",
      "high",
    ]);
    expect(withoutPromptInjectedOptions([CONTEXT_WINDOW])[0]).toBe(CONTEXT_WINDOW);
  });
});

it("shows Unknown until a matching provider report provides Default", () => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "ling",
    options: [],
  };
  const input = {
    provider: ProviderDriverKind.make("opencode"),
    descriptors: [
      selectDescriptor(
        "variant",
        [
          { id: "none", label: "None" },
          { id: "thinking", label: "Thinking" },
        ],
        "",
      ),
    ],
    primarySelectDescriptorId: "variant",
    ultrathinkPromptControlled: false,
    modelSelection: selection,
  };
  expect(buildTraitsTriggerDisplay(input).label).toBe("Unknown");
  expect(
    buildTraitsTriggerDisplay({
      ...input,
      reportedModelSelection: { ...selection, options: [{ id: "variant", value: "default" }] },
    }).label,
  ).toBe("Default");
});
