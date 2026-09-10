import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";
import {
  getAntigravityModelGroups,
  getAntigravityReasoningControl,
  groupAntigravityModelRows,
} from "./antigravityModelPresentation.ts";

const model = (
  level: string,
  overrides: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({
  slug: `gemini-3.8-flash-${level.toLowerCase()}`,
  name: `Gemini 3.8 Flash (${level})`,
  isCustom: false,
  capabilities: { optionDescriptors: [] },
  ...overrides,
});
const catalog = [model("High", { isDefault: true }), model("Medium"), model("Low")];

describe("Antigravity native model presentation", () => {
  it("groups native variants without changing the source catalog", () => {
    const before = structuredClone(catalog);
    const groups = getAntigravityModelGroups("antigravity", catalog);
    expect(groups).toEqual([
      {
        name: "Gemini 3.8 Flash",
        models: ["Low", "Medium", "High"].map((level) => ({
          slug: model(level).slug,
          label: level,
        })),
      },
    ]);
    expect(groupAntigravityModelRows(catalog, groups)).toEqual([
      { ...catalog[0], name: "Gemini 3.8 Flash", shortName: "Gemini 3.8 Flash" },
    ]);
    expect(catalog).toEqual(before);
  });

  it.each(["High", "Medium", "Low"])(
    "keeps an existing %s selection instead of resetting it",
    (level) => {
      const selected = model(level).slug;
      const groups = getAntigravityModelGroups("antigravity", catalog);
      expect(groupAntigravityModelRows(catalog, groups, selected)[0]?.slug).toBe(selected);
      const control = getAntigravityReasoningControl(groups, selected)!;
      expect(control.currentValue).toBe(selected);
      expect(control.options.find((option) => option.id === selected)?.label).toBe(level);
      expect(
        control.options.every((option) => catalog.some((model) => model.slug === option.id)),
      ).toBe(true);
    },
  );

  it("never guesses unavailable levels or replaces a disappeared selection", () => {
    const available = catalog.filter((entry) => entry.slug !== model("Medium").slug);
    const groups = getAntigravityModelGroups("antigravity", available);
    expect(getAntigravityReasoningControl(groups, model("Medium").slug)).toBeNull();
    expect(
      getAntigravityReasoningControl(groups, model("Low").slug)?.options.map(
        (option) => option.label,
      ),
    ).toEqual(["Low", "High"]);
    const unavailable = { ...model("Medium"), isUnavailable: true };
    expect(
      groupAntigravityModelRows([...available, unavailable], groups, unavailable.slug),
    ).toContainEqual(unavailable);
  });

  it("respects filtered/hidden rows and never resurrects the native default", () => {
    const visible = catalog.slice(1);
    const groups = getAntigravityModelGroups("antigravity", catalog);
    expect(groupAntigravityModelRows(visible, groups)[0]?.slug).toBe(model("Medium").slug);
    expect(groupAntigravityModelRows([], groups)).toEqual([]);
  });

  it("keeps search results selectable by their exact matching native ID", () => {
    const groups = getAntigravityModelGroups("antigravity", catalog);
    expect(groupAntigravityModelRows([catalog[2]!], groups, model("High").slug)[0]?.slug).toBe(
      model("Low").slug,
    );
  });

  it.each(["codex", "claudeAgent", "grok", "cursor", "droid", "opencode"])(
    "does not alter %s",
    (driver) => {
      const groups = getAntigravityModelGroups(driver, catalog);
      expect(groups).toEqual([]);
      expect(groupAntigravityModelRows(catalog, groups)).toEqual(catalog);
    },
  );

  it.each([
    model("High", { isCustom: true }),
    model("High", {
      capabilities: {
        optionDescriptors: [{ id: "reasoning", type: "select", label: "Reasoning", options: [] }],
      },
    }),
    model("High", { name: "Different (High)" }),
    model("High", { isLegacy: true }),
  ])("leaves ambiguous, custom, native-option or mixed-generation families alone", (high) => {
    // A malformed/unrecognized member must not cause recognized siblings to be merged with it.
    const entries = [high, model("Low")];
    const groups = getAntigravityModelGroups("antigravity", entries);
    expect(groups).toEqual([]);
    expect(groupAntigravityModelRows(entries, groups)).toEqual(entries);
  });

  it("does not group an existing legacy base model or arbitrary thinking names", () => {
    const entries = [
      ...catalog,
      model("High", { slug: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }),
      model("High", { slug: "claude-opus-thinking", name: "Claude Opus Thinking" }),
    ];
    expect(getAntigravityModelGroups("antigravity", entries)).toEqual([]);
  });

  it("does not map the unresolved default alias or unknown IDs to an arbitrary effort", () => {
    const groups = getAntigravityModelGroups("antigravity", catalog);
    expect(getAntigravityReasoningControl(groups, "antigravity-default")).toBeNull();
    expect(getAntigravityReasoningControl(groups, "invented-high")).toBeNull();
  });
});
