import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import {
  applyAutomaticModelDefaults,
  getProviderOptionDescriptors,
  getProviderOptionCurrentValue,
  resolveAutomaticModel,
  resolveSelectableModel,
} from "./model.ts";

const model = (slug: string, extra: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...extra,
});
const reasoning = (id: string, levels = ["low", "medium", "high"]) => ({
  optionDescriptors: [
    {
      id,
      label: "Reasoning",
      type: "select" as const,
      currentValue: "medium",
      options: levels.map((level) => ({ id: level, label: level, isDefault: level === "medium" })),
    },
  ],
});
const cases = [
  ["scient", "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra", "thinkingLevel"],
  ["scient", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "thinkingLevel"],
  ["scient", "cursor/grok-4.7-high", "cursor/claude-opus-5-high", "thinkingLevel"],
  [
    "scient",
    "google-antigravity/gemini-3.8-flash",
    "google-antigravity/gemini-3.1-pro",
    "thinkingLevel",
  ],
  ["cursor", "grok-4.7", "auto", "reasoning"],
  ["antigravity", "gemini-3.8-flash", "gemini-3.1-pro", "reasoningEffort"],
  ["codex", "gpt-6.1-sol", "gpt-6-astra", "reasoningEffort"],
  ["claudeAgent", "claude-opus-5-5", "claude-sonnet-5-5", "effort"],
] as const;

describe("preferred account defaults", () => {
  it.each(cases)(
    "prefers %s %s at high without replacing explicit choices",
    (kind, preferred, previous, id) => {
      const driver = ProviderDriverKind.make(kind);
      const input = [
        model(previous, { isDefault: true }),
        model(preferred, { capabilities: reasoning(id) }),
      ];
      const projected = applyAutomaticModelDefaults(driver, input);
      expect(resolveAutomaticModel(driver, input)).toBe(preferred);
      expect(projected.filter((entry) => entry.isDefault).map((entry) => entry.slug)).toEqual([
        preferred,
      ]);
      const descriptor = projected[1]!.capabilities!.optionDescriptors![0]!;
      expect(getProviderOptionCurrentValue(descriptor)).toBe("high");
      expect(
        getProviderOptionCurrentValue(
          getProviderOptionDescriptors({
            caps: { optionDescriptors: [descriptor] },
            selections: [{ id, value: "low" }],
          })[0]!,
        ),
      ).toBe("low");
      expect(resolveSelectableModel(driver, previous, projected)).toBe(previous);
      expect(input[1]!.capabilities!.optionDescriptors![0]!.currentValue).toBe("medium");
    },
  );

  it.each(cases)("falls back when %s %s is unavailable or custom", (kind, preferred, previous) => {
    const driver = ProviderDriverKind.make(kind);
    for (const extra of [
      { unavailableReason: "No access" },
      { isLegacy: true },
      { isCustom: true },
    ]) {
      expect(
        resolveAutomaticModel(driver, [
          model(previous, { isDefault: true }),
          model(preferred, extra),
        ]),
      ).toBe(previous);
    }
    expect(resolveAutomaticModel(driver, [model(previous)])).toBe(previous);
  });

  it("preserves account order when several preferred accounts are present", () => {
    const driver = ProviderDriverKind.make("scient");
    const anthropic = model("anthropic/claude-opus-5-5");
    const codex = model("openai-codex/gpt-6.1-sol");
    expect(resolveAutomaticModel(driver, [anthropic, codex])).toBe(anthropic.slug);
    expect(resolveAutomaticModel(driver, [codex, anthropic])).toBe(codex.slug);
  });

  it("keeps custom reasoning defaults and unsupported high levels", () => {
    const driver = ProviderDriverKind.make("scient");
    for (const entry of [
      model("openai-codex/gpt-6.1-sol", {
        isCustom: true,
        capabilities: reasoning("thinkingLevel"),
      }),
      model("anthropic/claude-opus-5-5", {
        capabilities: reasoning("thinkingLevel", ["low", "medium"]),
      }),
    ]) {
      expect(applyAutomaticModelDefaults(driver, [entry])[0]!.capabilities).toEqual(
        entry.capabilities,
      );
    }
  });

  it("prefers exact high native variants and preserves parameterized Cursor IDs", () => {
    for (const kind of ["scient", "cursor"] as const) {
      const prefix = kind === "scient" ? "cursor/" : "";
      const driver = ProviderDriverKind.make(kind);
      const high = `${prefix}grok-4.7-high`;
      expect(resolveAutomaticModel(driver, [model(`${prefix}grok-4.7`), model(high)])).toBe(high);
      const parameterized = `${prefix}grok-4.7[reasoning=medium,fast=false]`;
      expect(
        resolveAutomaticModel(driver, [
          model(`${prefix}other`, { isDefault: true }),
          model(parameterized),
        ]),
      ).toBe(parameterized);
    }
    expect(
      resolveAutomaticModel(ProviderDriverKind.make("antigravity"), [
        model("gemini-3.8-flash-low"),
        model("gemini-3.8-flash-high"),
      ]),
    ).toBe("gemini-3.8-flash-high");
  });

  it.each(["pi", "omp"])("leaves %s runtime defaults intact", (kind) => {
    const models = [
      model("openai-codex/gpt-6-astra", { isDefault: true }),
      model("openai-codex/gpt-6.1-sol"),
    ];
    expect(resolveAutomaticModel(ProviderDriverKind.make(kind), models)).toBe(models[0]!.slug);
  });
});
