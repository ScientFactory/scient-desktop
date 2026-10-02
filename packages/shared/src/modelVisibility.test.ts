import { describe, expect, it } from "vite-plus/test";
import { getDefaultHiddenAgentModels, resolveProviderModelPreferences } from "./model.ts";

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
  "google-antigravity/gemini-example",
  "openai/gpt-example",
].map((slug) => ({ slug }));

describe("curated native agent model visibility", () => {
  it.each(["pi", "omp"])("keeps the requested %s models and other routes visible", (driver) => {
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
      "google-antigravity/gemini-example",
      "openai/gpt-example",
    ]);
  });
  it("leaves custom models and other drivers alone", () => {
    expect(
      getDefaultHiddenAgentModels("omp", [{ slug: "anthropic/custom", isCustom: true }]),
    ).toEqual([]);
    expect(getDefaultHiddenAgentModels("claudeAgent", models)).toEqual([]);
    expect(getDefaultHiddenAgentModels("codex", models)).toEqual([]);
  });
  it("does not invent a Fable 5.5 entry", () => {
    const catalog = [{ slug: "anthropic/claude-fable-5-1" }];
    expect(getDefaultHiddenAgentModels("omp", catalog)).toEqual([catalog[0]!.slug]);
  });
  it("preserves a user's list including an explicitly empty list after a reload", () => {
    const saved = {
      hiddenModels: ["anthropic/claude-opus-5-5"],
      modelOrder: ["openai-codex/gpt-6-luna"],
    };
    expect(resolveProviderModelPreferences("omp", models, saved)).toBe(saved);
    expect(
      resolveProviderModelPreferences("omp", models, { hiddenModels: [], modelOrder: [] })
        .hiddenModels,
    ).toEqual([]);
    expect(resolveProviderModelPreferences("omp", models, undefined).hiddenModels).toContain(
      "anthropic/claude-haiku-4-5",
    );
  });
});
