import { describe, expect, it } from "vite-plus/test";
import {
  getDefaultHiddenAgentModels,
  resolveProviderModelPreferences,
  sortAgentModelsByAccount,
} from "./model.ts";

const models = [
  "anthropic/claude-3-5-sonnet-20240620",
  "anthropic/claude-sonnet-4-5-20250929",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-4-5-20251101",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-fable-5-1",
  "anthropic/claude-fable-5-5",
  "anthropic/claude-mythos-5-1",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-6.1-sol",
  "google-antigravity/gemini-3-flash",
  "google-antigravity/gemini-3.8-flash",
  "google-antigravity/gemini-3.1-pro",
  "google-antigravity/claude-opus-4-5",
  "google-antigravity/claude-opus-4-6",
  "google/gemini-example",
  "openai/gpt-example",
].map((slug) => ({ slug }));

describe("curated native agent model visibility", () => {
  it.each(["pi", "omp", "scient"])(
    "orders %s accounts without changing within-group order",
    (driver) => {
      const catalog = [
        "google-antigravity/claude-opus-4-6",
        "openai-codex/gpt-6-luna",
        "anthropic/claude-opus-5-5",
        "google-antigravity/gemini-3.8-flash",
        "ollama/local",
        "openai/api-model",
        "anthropic/claude-sonnet-5-5",
        "google-gemini-cli/gemini-example",
      ].map((slug) => ({ slug }));
      const original = [...catalog];
      const ordered = sortAgentModelsByAccount(driver, catalog).map((model) => model.slug);
      expect(ordered).toEqual([
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "openai-codex/gpt-6-luna",
        "openai/api-model",
        "google-antigravity/claude-opus-4-6",
        "google-antigravity/gemini-3.8-flash",
        "google-gemini-cli/gemini-example",
        "ollama/local",
      ]);
      expect(catalog).toEqual(original);
      expect(resolveProviderModelPreferences(driver, catalog, undefined).modelOrder).toEqual(
        ordered,
      );
      const savedVisibility = { hiddenModels: ["ollama/local"], modelOrder: [] };
      const resolved = resolveProviderModelPreferences(driver, catalog, savedVisibility);
      expect(resolved.hiddenModels).toBe(savedVisibility.hiddenModels);
      expect(resolved.modelOrder).toEqual(ordered);
    },
  );
  it("preserves saved order and leaves other drivers' catalog order unchanged", () => {
    const saved = {
      hiddenModels: [],
      modelOrder: ["google-antigravity/gemini-3.8-flash", "anthropic/claude-opus-5-5"],
    };
    expect(resolveProviderModelPreferences("omp", models, saved)).toBe(saved);
    expect(sortAgentModelsByAccount("antigravity", models)).toEqual(models);
    expect(sortAgentModelsByAccount("codex", models)).toEqual(models);
    expect(resolveProviderModelPreferences("antigravity", models, undefined).modelOrder).toEqual(
      [],
    );
  });
  it.each(["pi", "omp", "scient"])(
    "keeps the requested %s models and other routes visible",
    (driver) => {
      const hidden = getDefaultHiddenAgentModels(driver, models);
      expect(
        models.filter((model) => !hidden.includes(model.slug)).map((model) => model.slug),
      ).toEqual([
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-fable-5-5",
        "openai-codex/gpt-6-astra",
        "openai-codex/gpt-6-luna",
        "openai-codex/gpt-6.1-sol",
        "google-antigravity/gemini-3.8-flash",
        "google-antigravity/gemini-3.1-pro",
        "google-antigravity/claude-opus-4-6",
        "google/gemini-example",
        "openai/gpt-example",
      ]);
    },
  );
  it("leaves custom models and other drivers alone", () => {
    expect(
      getDefaultHiddenAgentModels("omp", [
        { slug: "anthropic/custom", isCustom: true },
        { slug: "google-antigravity/custom", isCustom: true },
      ]),
    ).toEqual([]);
    expect(getDefaultHiddenAgentModels("claudeAgent", models)).toEqual([]);
    expect(getDefaultHiddenAgentModels("codex", models)).toEqual([]);
    expect(getDefaultHiddenAgentModels("antigravity", models)).toEqual([]);
  });
  it("does not invent a Fable 5.5 entry", () => {
    const catalog = [{ slug: "anthropic/claude-fable-5-1" }];
    expect(getDefaultHiddenAgentModels("omp", catalog)).toEqual([catalog[0]!.slug]);
  });
  it.each(["pi", "omp", "scient"])(
    "preserves %s saved visibility and order after a reload",
    (driver) => {
      const saved = {
        hiddenModels: ["anthropic/claude-opus-5-5"],
        modelOrder: ["openai-codex/gpt-6-luna"],
      };
      expect(resolveProviderModelPreferences(driver, models, saved)).toBe(saved);
      expect(
        resolveProviderModelPreferences(driver, models, { hiddenModels: [], modelOrder: [] })
          .hiddenModels,
      ).toEqual([]);
      expect(resolveProviderModelPreferences(driver, models, undefined).hiddenModels).toContain(
        "anthropic/claude-haiku-4-5",
      );
    },
  );
});
