import { describe, expect, it } from "@effect/vitest";
import { normalizeInheritedEvent, consentAllows, modelKey } from "./contract.ts";
import { eventContractViolation } from "./wireContract.ts";

const context = { appVersion: "0.6.10", buildChannel: "stable" } as const;
describe("product insight contract", () => {
  it("preserves Visual LaTeX categories but strips document content and identifiers", () => {
    for (const [name, properties] of [
      ["feature.viewed", { feature: "latex-visual" }],
      ["scient.operation.started", { operationKind: "latex-visual-edit", trigger: "user" }],
      ["scient.operation.completed", { operationKind: "latex-visual-edit", durationMs: 100 }],
      ["scient.operation.failed", { operationKind: "latex-visual-edit", failureClass: "unknown" }],
    ] as const) {
      const event = normalizeInheritedEvent(
        name,
        {
          ...properties,
          source: "\\documentclass{article} PRIVATE",
          path: "PRIVATE",
          file: "/Users/someone/PRIVATE.tex",
          text: "PRIVATE",
          error: "PRIVATE",
        },
        context,
      )!;
      expect(event.properties).toMatchObject(
        "feature" in properties
          ? { feature: "latex-visual" }
          : { operationKind: "latex-visual-edit" },
      );
      expect(JSON.stringify(event)).not.toContain("PRIVATE");
      expect(eventContractViolation({ ...event, consentLevel: event.privacyLevel })).toBeNull();
      expect(consentAllows("off", event.privacyLevel)).toBe(false);
      expect(consentAllows("essential", event.privacyLevel)).toBe(
        name === "scient.operation.failed",
      );
    }
  });
  it("folds public namespaces and Antigravity variants into one model key", () => {
    expect(modelKey("openai/gpt-5.4")).toBe("gpt-5.4");
    expect(modelKey("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(modelKey("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
    expect(modelKey("google/gemini-3.7-flash-low")).toBe("gemini-3.7-flash");
    expect(modelKey("lab/gpt-5.4")).toBe("lab/gpt-5.4");
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
        {
          model: "not a model id",
          usageStatus: "complete",
          inputTokens: value,
          outputTokens: 20,
        },
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
  it("keeps UI categories but strips paths and free text", () => {
    for (const [name, key] of [
      ["panel.viewed", "category"],
      ["settings.viewed", "section"],
      ["feature.viewed", "feature"],
      ["usage.viewed", "metric"],
    ] as const) {
      for (const value of [
        "/Users/someone/PRIVATE",
        "a PRIVATE sentence",
        "https://PRIVATE.example",
        "PRIVATE@example.com",
      ]) {
        const event = normalizeInheritedEvent(
          name,
          { [key]: value, path: "PRIVATE", title: "PRIVATE" },
          context,
        )!;
        expect(event.properties[key]).toBe("other");
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
    }
  });
});
