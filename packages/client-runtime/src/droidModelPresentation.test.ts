import { describe, expect, it } from "vite-plus/test";
import { getDroidModelSection, groupDroidModelRows } from "./droidModelPresentation.ts";

const row = (slug: string, name = slug) => ({ slug, name });

describe("Droid model presentation", () => {
  // One row per branch of getDroidModelSection.
  it.each([
    "gpt-4o", // major below 5
    "gpt-5", // no minor
    "gpt-5.5-pro", // minor below 6
    "claude-opus-4-8", // curated as superseded
    "claude-opus-4-6", // older Claude, bare
    "claude-opus-4-7-fast", // older Claude, suffixed
    "claude-sonnet-4-5-20250929", // older Sonnet
  ])("places %s in More models", (slug) => {
    expect(getDroidModelSection(row(slug))).toBe("more");
  });
  it.each([
    "gpt-5.6",
    "gpt-5.10", // minor compared as a number
    "gpt-6",
    "claude-opus-5",
    "claude-sonnet-4-7",
    "new-provider-model",
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
