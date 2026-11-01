import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { getComposerProviderState } from "./composerProviderState";

const MODEL = "test-model";
const PI = ProviderDriverKind.make("pi");

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

function strictThinking(empty: boolean): ProviderOptionDescriptor {
  return {
    id: "thinking",
    label: "Reasoning",
    type: "select",
    strictSelection: true,
    options: empty ? [] : [{ id: "default", label: "Default (Medium)", isDefault: true }],
  };
}

// One row per branch of concrete reasoning resolution (packages/shared/src/model.ts):
// no saved value, a placeholder keyword, an unknown level, and an offered level.
it.each([undefined, "default", "invalid", "low"])(
  "shows and dispatches the same concrete reasoning level for saved %s",
  (saved) => {
    const state = getComposerProviderState({
      provider: PI,
      model: MODEL,
      models: modelWith([
        {
          id: "thinkingLevel",
          label: "Reasoning",
          type: "select",
          strictSelection: true,
          concreteReasoning: true,
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ],
        },
      ]),
      modelOptions: saved === undefined ? undefined : selections(["thinkingLevel", saved]),
      planModeEnabled: false,
    });
    const expected = saved === "low" ? saved : "max";
    expect(state.promptEffort).toBe(expected);
    expect(state.modelOptionsForDispatch).toEqual(selections(["thinkingLevel", expected]));
  },
);

it("does not dispatch a synthetic reasoning option for native Antigravity variants", () => {
  const provider = ProviderDriverKind.make("antigravity");
  const models = ["High", "Medium", "Low"].map((level) => ({
    slug: `gemini-3.8-flash-${level.toLowerCase()}`,
    name: `Gemini 3.8 Flash (${level})`,
    isCustom: false,
    capabilities: {
      optionDescriptors: [],
    },
  }));
  for (const model of models) {
    const state = getComposerProviderState({
      provider,
      models,
      model: model.slug,
      modelOptions: undefined,
      planModeEnabled: false,
    });
    expect(state.modelOptionsForDispatch).toBeUndefined();
    expect(state.promptEffort).toBeNull();
  }
});

describe("strict Pi thinking", () => {
  it("preserves an explicit choice that matches the default", () => {
    const state = getComposerProviderState({
      provider: PI,
      model: MODEL,
      models: modelWith([strictThinking(false)]),
      modelOptions: selections(["thinking", "default"]),
      planModeEnabled: false,
    });
    expect(state.modelOptionsForDispatch).toEqual(selections(["thinking", "default"]));
  });

  it("preserves invalid Pi thinking for server validation", () => {
    const state = getComposerProviderState({
      provider: PI,
      model: MODEL,
      models: modelWith([strictThinking(true)]),
      modelOptions: selections(["thinking", "max"]),
      planModeEnabled: false,
    });
    expect(state.modelOptionsForDispatch).toEqual(selections(["thinking", "max"]));
  });

  it.each([true, false])(
    "does not dispatch an implicit Pi thinking default (empty: %s)",
    (empty) => {
      const state = getComposerProviderState({
        provider: PI,
        model: MODEL,
        models: modelWith([strictThinking(empty)]),
        modelOptions: undefined,
        planModeEnabled: false,
      });
      expect(state.modelOptionsForDispatch).toBeUndefined();
      if (empty) expect(state.promptEffort).toBeNull();
    },
  );
});
