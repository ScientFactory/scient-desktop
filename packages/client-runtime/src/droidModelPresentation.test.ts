import { describe, expect, it } from "vite-plus/test";
import { getDroidModelSection, groupDroidModelRows } from "./droidModelPresentation.ts";

const row = (slug: string, name = slug) => ({ slug, name });

describe("Droid model presentation", () => {
  it.each([
    "gpt-4o",
    "gpt-5",
    "gpt-5.5-pro",
    "gpt-5.4-mini-fast",
    "gpt-5.3-codex",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-4-8-fast",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "kimi-k2.6",
    "grok-4.5",
    "claude-sonnet-4-5-20250929",
    // Superseded in both the managed Droid 0.213.0 catalog and 0.230.0's.
    "claude-opus-4-7-fast",
    "claude-opus-4-6-fast",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "glm-5.1",
    "glm-5",
    "glm-4.7",
    "kimi-k2.5",
  ])("places %s in More models", (slug) => {
    expect(getDroidModelSection(row(slug))).toBe("more");
  });
  it.each([
    "gpt-5.6",
    "gpt-5.6-mini",
    "gpt-5.10",
    "gpt-6",
    "claude-opus-5-fast",
    "claude-opus-5",
    "gemini-3.7-flash",
    "gemini-4-flash",
    "kimi-k2.7-code",
    "kimi-k3",
    "grok-4.6",
    "claude-sonnet-4-7",
    "claude-haiku-4-6",
    "new-provider-model",
    // Droid 0.230.0's newest, and models that are still the newest in 0.213.0.
    "claude-fable-5.1",
    "claude-fable-5",
    "claude-opus-5-5",
    "gpt-6-sol",
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gemini-3.8-flash",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "qwen3.8-max",
    "grok-4.7",
    "mistral-medium-3.5",
    "minimax-m2.7",
    "deepseek-v4-pro",
  ])("keeps %s visible", (slug) => {
    expect(getDroidModelSection(row(slug))).toBe("models");
  });
  it("uses native deprecation labels but never demotes custom models", () => {
    expect(getDroidModelSection(row("kimi-k2.5", "Kimi [Deprecated]"))).toBe("more");
    expect(
      getDroidModelSection({ ...row("custom:gpt-4-0", "GPT [Deprecated]"), isLegacy: true }),
    ).toBe("custom");
    expect(getDroidModelSection(row("custom:Grok-4.5-0", "Grok 4.5"))).toBe("custom");
  });
  it("keeps new discoveries visible and does not demote existing models when a newer one arrives", () => {
    const before = [row("claude-opus-5"), row("custom:scient-fixture"), row("claude-opus-4-7")];
    const after = groupDroidModelRows([...before, row("claude-opus-6"), row("future-model")]);
    expect(after.models.map((model) => model.slug)).toEqual([
      "claude-opus-5",
      "claude-opus-6",
      "future-model",
    ]);
    expect(after.more).toEqual([row("claude-opus-4-7")]);
  });
  it("preserves user order within sections and loses no rows", () => {
    const rows = [
      row("gpt-5.4"),
      row("custom:personal-0"),
      row("claude-opus-5"),
      row("gpt-5.5"),
      row("custom:scient-fixture"),
      row("gpt-5.3-codex"),
    ];
    const groups = groupDroidModelRows(rows);
    expect(groups.models.map((model) => model.slug)).toEqual(["claude-opus-5"]);
    expect(groups.custom.map((model) => model.slug)).toEqual([
      "custom:personal-0",
      "custom:scient-fixture",
    ]);
    expect(groups.more.map((model) => model.slug)).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.3-codex"]);
    expect(Object.values(groups).flat()).toHaveLength(rows.length);
    expect(groupDroidModelRows([])).toEqual({ models: [], custom: [], more: [] });
  });
});
