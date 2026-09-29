import { ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelSourceSectionRows,
  CollapsedModelSources,
  groupModelsBySource,
  hasModelSourceSections,
  modelSourceSection,
  modelSourceSectionKey,
  modelSourceSectionLabel,
  parseModelSourceSectionKey,
} from "./modelSourceSections";

const instanceId = ProviderInstanceId.make("omp");
const model = (slug: string, subProvider?: string) => ({
  slug,
  ...(subProvider ? { subProvider } : {}),
});

describe("model source sections", () => {
  it("applies to Oh My Pi and Pi only", () => {
    expect(hasModelSourceSections("omp")).toBe(true);
    expect(hasModelSourceSections("pi")).toBe(true);
    expect(hasModelSourceSections("droid")).toBe(false);
    expect(hasModelSourceSections(undefined)).toBe(false);
  });

  it("puts models registered under a Scient connection in the custom section", () => {
    expect(modelSourceSection("scient_openrouter/glm")).toBe("custom");
    expect(modelSourceSection("scient_4b1c%2Fx/model")).toBe("custom");
    expect(modelSourceSection("anthropic/claude")).toBe("accounts");
    expect(modelSourceSection("openai-codex/scient_lookalike")).toBe("accounts");
  });

  it("keeps each account provider's models together in first-appearance order", () => {
    const groups = groupModelsBySource([
      model("anthropic/opus", "anthropic"),
      model("scient_openrouter/glm", "OpenRouter"),
      model("openai-codex/gpt", "openai-codex"),
      model("anthropic/sonnet", "anthropic"),
      model("scient_local/qwen", "Local"),
    ]);
    expect(groups?.accounts.map((row) => row.slug)).toEqual([
      "anthropic/opus",
      "anthropic/sonnet",
      "openai-codex/gpt",
    ]);
    expect(groups?.custom.map((row) => row.slug)).toEqual([
      "scient_openrouter/glm",
      "scient_local/qwen",
    ]);
  });

  it("shows no sections when either one would be empty", () => {
    expect(groupModelsBySource([model("anthropic/opus", "anthropic")])).toBeNull();
    expect(groupModelsBySource([model("scient_local/qwen", "Local")])).toBeNull();
    expect(groupModelsBySource([])).toBeNull();
  });

  it("round-trips section keys", () => {
    const otherInstance = ProviderInstanceId.make("omp-work");
    for (const section of ["accounts", "custom"] as const) {
      expect(parseModelSourceSectionKey(modelSourceSectionKey(otherInstance, section))).toEqual({
        instanceId: otherInstance,
        section,
      });
    }
    expect(parseModelSourceSectionKey("model-source:other:omp")).toBeNull();
    expect(parseModelSourceSectionKey("model-source:custom:")).toBeNull();
    expect(parseModelSourceSectionKey("model:3:ompanthropic/opus")).toBeNull();
  });

  it("names the account section after the provider instance", () => {
    expect(modelSourceSectionLabel("accounts", "Oh My Pi")).toBe("Your Oh My Pi accounts");
    expect(modelSourceSectionLabel("custom", "Oh My Pi")).toBe("Scient custom models");
  });

  it("stores collapsed sections as a string list", () => {
    const codec = Schema.fromJsonString(CollapsedModelSources);
    const stored = Schema.encodeSync(codec)([modelSourceSectionKey(instanceId, "custom")]);
    expect(Schema.decodeSync(codec)(stored)).toEqual(["model-source:custom:omp"]);
  });
});

describe("model source section rows", () => {
  const groups = {
    accounts: [model("anthropic/opus", "anthropic"), model("anthropic/sonnet", "anthropic")],
    custom: [model("scient_local/qwen", "Local")],
  };
  const accountsKey = modelSourceSectionKey(instanceId, "accounts");
  const customKey = modelSourceSectionKey(instanceId, "custom");
  const build = (collapsed: ReadonlyArray<string>, revealed: ReadonlyArray<string> = []) =>
    buildModelSourceSectionRows({
      instanceId,
      groups,
      collapsed: new Set(collapsed),
      revealed: new Set(revealed),
      modelKey: (row) => `model:${row.slug}`,
    });

  it("lists each header followed by its models when both are expanded", () => {
    const rows = build([]);
    expect(rows.itemKeys).toEqual([
      accountsKey,
      "model:anthropic/opus",
      "model:anthropic/sonnet",
      customKey,
      "model:scient_local/qwen",
    ]);
    expect(rows.visibleModels).toHaveLength(3);
    expect(rows.sections.get(customKey)).toEqual({ section: "custom", count: 1, expanded: true });
  });

  it("hides a collapsed section's models but keeps its header and count", () => {
    const rows = build([accountsKey]);
    expect(rows.itemKeys).toEqual([accountsKey, customKey, "model:scient_local/qwen"]);
    expect(rows.visibleModels.map((row) => row.slug)).toEqual(["scient_local/qwen"]);
    expect(rows.sections.get(accountsKey)).toEqual({
      section: "accounts",
      count: 2,
      expanded: false,
    });
  });

  it("keeps a collapsed section open while it is revealed", () => {
    const rows = build([customKey], [customKey]);
    expect(rows.itemKeys).toContain("model:scient_local/qwen");
    expect(rows.sections.get(customKey)?.expanded).toBe(true);
  });

  it("ignores collapsed keys that belong to another instance", () => {
    const rows = build([modelSourceSectionKey(ProviderInstanceId.make("pi"), "accounts")]);
    expect(rows.visibleModels).toHaveLength(3);
  });
});
