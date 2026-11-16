import { describe, expect, it } from "vite-plus/test";
import {
  getDefaultHiddenAgentModels,
  resolveProviderModelPreferences,
  sortAgentModelsByAccount,
} from "./model.ts";

const models = [
  "anthropic/claude-sonnet-4-5-20250929",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-fable-5-2",
  "anthropic/claude-fable-5-1",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6.1-sol",
  "openai-codex/gpt-6.1-terra",
  "google-antigravity/gemini-3.8-flash",
  "google-antigravity/gemini-3.1-pro",
  "google-antigravity/gemini-4-hydrogen",
  "google-antigravity/gemini-4-argon",
  "google-antigravity/claude-opus-5-5",
  "antigravity-cli/gemini-4-carbon",
  "antigravity-cli/gemini-4-hydrogen",
  "muse-code/muse-spark-1.3",
  "muse-code/muse-wonder-full-1.0",
  "muse-code/muse-wonder-1.0",
  "muse-code/muse-ember-1.0",
].map((slug) => ({ slug }));

describe("curated native agent model visibility", () => {
  // regression: f9ed7a0233 fix(scient-agent): share native model selection policy
  it.each(["pi", "omp", "scient"])(
    "orders %s accounts without changing within-group order",
    (driver) => {
      const catalog = [
        "google-antigravity/gemini-4-hydrogen",
        "openai-codex/gpt-6-luna",
        "anthropic/claude-opus-5-5",
        "google-antigravity/gemini-4-argon",
        "ollama/local",
        "openai/api-model",
        "anthropic/claude-sonnet-5-5",
      ].map((slug) => ({ slug }));
      const original = [...catalog];
      const ordered = sortAgentModelsByAccount(driver, catalog).map((model) => model.slug);
      expect(ordered).toEqual([
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "openai-codex/gpt-6-luna",
        "openai/api-model",
        "google-antigravity/gemini-4-hydrogen",
        "google-antigravity/gemini-4-argon",
        "ollama/local",
      ]);
      expect(catalog).toEqual(original);
      expect(resolveProviderModelPreferences(driver, catalog, undefined).modelOrder).toEqual(
        ordered,
      );
    },
  );

  it.each(["pi", "omp", "scient"])("hides only known irrelevant %s IDs", (driver) => {
    expect(getDefaultHiddenAgentModels(driver, models)).toEqual([
      "anthropic/claude-sonnet-4-5-20250929",
      "anthropic/claude-fable-5-1",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-6-sol",
      "google-antigravity/gemini-3.8-flash",
      "google-antigravity/gemini-3.1-pro",
      "antigravity-cli/gemini-4-carbon",
      "muse-code/muse-spark-1.3",
    ]);
    const additions = [
      "anthropic/claude-future",
      "openai-codex/gpt-future",
      "google-antigravity/gemini-future",
      "antigravity-cli/gemini-future",
      "muse-code/muse-future",
      "openai/api-model",
      "ollama/local",
    ].map((slug) => ({ slug }));
    expect(getDefaultHiddenAgentModels(driver, additions)).toEqual([]);
    expect(
      getDefaultHiddenAgentModels(
        driver,
        models.map((model) => ({ ...model, isCustom: true })),
      ),
    ).toEqual([]);
  });

  it.each(["pi", "omp", "scient", "antigravity", "muse"])(
    "preserves %s saved preferences, including explicit re-enablement and empty order",
    (driver) => {
      const saved = {
        hiddenModels: ["my/custom"],
        modelOrder: ["my/custom", "openai-codex/gpt-6-luna"],
        favoriteModels: ["my/custom"],
      };
      expect(resolveProviderModelPreferences(driver, models, saved)).toBe(saved);
      const reenabled = { hiddenModels: [], modelOrder: [] };
      expect(resolveProviderModelPreferences(driver, models, reenabled)).toBe(reenabled);
    },
  );

  it("applies standalone policy without hiding unrelated routes or custom models", () => {
    const catalog = [
      "gemini-4-carbon",
      "gemini-3.8-flash",
      "gemini-4-hydrogen",
      "gemini-future",
      "muse-spark-1.3",
      "muse-wonder-full-1.0",
    ].map((slug) => ({ slug }));
    expect(resolveProviderModelPreferences("antigravity", catalog, undefined)).toEqual({
      hiddenModels: ["gemini-4-carbon", "gemini-3.8-flash"],
      modelOrder: [],
    });
    expect(resolveProviderModelPreferences("muse", catalog, undefined)).toEqual({
      hiddenModels: ["muse-spark-1.3"],
      modelOrder: [],
    });
    expect(
      getDefaultHiddenAgentModels(
        "antigravity",
        catalog.map((entry) => ({ ...entry, isCustom: true })),
      ),
    ).toEqual([]);
    expect(
      getDefaultHiddenAgentModels(
        "muse",
        catalog.map((entry) => ({ ...entry, isCustom: true })),
      ),
    ).toEqual([]);
    for (const driver of ["claudeAgent", "codex", "cursor"]) {
      expect(getDefaultHiddenAgentModels(driver, catalog)).toEqual([]);
      expect(sortAgentModelsByAccount(driver, models)).toEqual(models);
    }
  });
});
