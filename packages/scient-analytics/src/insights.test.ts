import { describe, expect, it } from "@effect/vitest";
import { normalizeInheritedEvent, consentAllows, modelKey } from "./contract.ts";
import { eventContractViolation } from "./wireContract.ts";

const context = { appVersion: "0.6.10", buildChannel: "stable" } as const;
describe("product insight contract", () => {
  it("recognizes bounded public namespaces and Antigravity variants without private labels", () => {
    expect(modelKey("openai/gpt-5.4")).toBe("gpt-5.4");
    expect(modelKey("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(modelKey("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
    expect(modelKey("google/gemini-3.7-flash-low")).toBe("gemini-3.7-flash");
    expect(modelKey("private/gpt-5.4")).toBe("other");
    expect(modelKey("openai/PRIVATE")).toBe("other");
  });
  it("preserves exact reported usage without adding overlapping subsets", () => {
    const event = normalizeInheritedEvent(
      "provider.turn.completed",
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        terminalStatus: "completed",
        usageStatus: "complete",
        inputTokens: 500,
        outputTokens: 100,
        cachedInputTokens: 300,
        reasoningTokens: 75,
        hasSubagents: true,
        path: "PRIVATE",
        usage: { prompt: "PRIVATE" },
      },
      context,
    )!;
    expect(event.name).toBe("provider.turn.usage");
    expect(event.properties).toMatchObject({
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 300,
      reasoningTokens: 75,
      modelKey: "gpt-5.6-sol",
      usageScope: "main_agent",
      usageStatus: "complete",
    });
    expect(
      eventContractViolation({
        name: event.name,
        properties: event.properties,
        privacyLevel: event.privacyLevel,
        consentLevel: "product",
      }),
    ).toBeNull();
    expect(consentAllows("essential", event.privacyLevel)).toBe(false);
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
  });
  it("does not fabricate zero usage or attribute mixed/private model totals", () => {
    for (const value of [-1, 0.5, Infinity, NaN, 1_000_000_001, "500"]) {
      const event = normalizeInheritedEvent(
        "provider.turn.usage",
        { model: "PRIVATE", usageStatus: "complete", inputTokens: value, outputTokens: 20 },
        context,
      )!;
      expect(event.properties.inputTokens).toBeUndefined();
      expect(event.properties.usageStatus).toBe("partial");
      expect(event.properties.modelKey).toBe("other");
    }
    expect(
      normalizeInheritedEvent("provider.turn.usage", {}, context)?.properties.usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeInheritedEvent(
        "provider.turn.usage",
        { model: "gpt-5.6-sol", mixedModels: true },
        context,
      )?.properties.modelKey,
    ).toBe("other");
  });
  it("bounds all UI categories and strips paths and arbitrary settings", () => {
    for (const name of ["panel.viewed", "settings.viewed", "feature.viewed", "usage.viewed"]) {
      const event = normalizeInheritedEvent(
        name,
        {
          category: "PRIVATE",
          section: "PRIVATE",
          feature: "PRIVATE",
          metric: "PRIVATE",
          path: "PRIVATE",
          value: "PRIVATE",
        },
        context,
      )!;
      expect(JSON.stringify(event)).not.toContain("PRIVATE");
      expect(
        eventContractViolation({
          name,
          properties: event.properties,
          privacyLevel: "product",
          consentLevel: "product",
        }),
      ).toBeNull();
    }
  });
});
