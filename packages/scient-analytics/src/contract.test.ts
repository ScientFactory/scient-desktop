import { describe, expect, it } from "@effect/vitest";

import { durationBucket, modelKey, normalizeInheritedEvent } from "./contract.ts";

const context = {
  appVersion: "0.0.32",
  buildChannel: "development" as const,
};

describe("Scient analytics contract", () => {
  it("does not turn inherited terminal notifications into duplicate successes", () => {
    for (const terminalStatus of ["completed", "failed", "cancelled", "interrupted"]) {
      expect(
        normalizeInheritedEvent(
          "provider.turn.completed",
          { provider: "pi", terminalStatus },
          context,
        ),
      ).toMatchObject({
        name: "provider.turn.usage",
        privacyLevel: "product",
        properties: {
          terminalStatus:
            terminalStatus === "cancelled" || terminalStatus === "interrupted"
              ? "stopped"
              : terminalStatus,
          usageStatus: "unavailable",
        },
      });
    }
    expect(
      normalizeInheritedEvent("provider.turn.completed", { provider: "pi" }, context)?.name,
    ).toBe("provider.turn.completed");
  });
  it("attributes Pi without collecting custom endpoint or model names", () => {
    const event = normalizeInheritedEvent(
      "provider.turn.sent",
      {
        provider: "pi",
        model: "private-local-model",
        endpoint: "https://private.example",
      },
      context,
    );
    expect(event?.properties).toMatchObject({ provider: "pi", modelKey: "other" });
    expect(JSON.stringify(event)).not.toContain("private");
  });
  it("keeps skipped source imports distinct from success and failure without private details", () => {
    const skipped = normalizeInheritedEvent(
      "scient.operation.skipped",
      {
        operationKind: "source-import",
        trigger: "user",
        durationMs: 450,
        title: "PRIVATE_SOURCE",
        itemKey: "PRIVATE_KEY",
        error: "PRIVATE_ERROR",
      },
      context,
    );
    expect(skipped).toMatchObject({
      name: "scient.operation.skipped",
      privacyLevel: "product",
      priority: "core",
      properties: { operationKind: "source-import", trigger: "user", durationBucket: "under-1s" },
    });
    expect(JSON.stringify(skipped)).not.toContain("PRIVATE");
  });
  it("keeps known model choices useful while suppressing custom model text", () => {
    expect(modelKey("gpt-5-codex")).toBe("gpt-5.4");
    expect(modelKey("claude-opus-4-6-20251117")).toBe("claude-opus-4-6");
    expect(modelKey("private-lab-model-alpha")).toBe("other");

    const normalized = normalizeInheritedEvent(
      "provider.turn.sent",
      { provider: "opencode", model: "private-lab-model-alpha" },
      context,
    );
    expect(normalized?.properties.modelKey).toBe("other");
    expect(JSON.stringify(normalized)).not.toContain("private-lab-model-alpha");
  });

  it("uses bounded duration and failure values", () => {
    expect(durationBucket(450)).toBe("under-1s");
    expect(durationBucket(75_000)).toBe("1-3m");
    expect(durationBucket(Number.POSITIVE_INFINITY)).toBe("unknown");

    expect(
      normalizeInheritedEvent(
        "provider.turn.failed",
        {
          provider: "codex",
          model: "gpt-5.6-sol",
          durationMs: 75_000,
          failureClass: "a private raw error",
        },
        context,
      ),
    ).toMatchObject({
      properties: {
        modelKey: "gpt-5.6-sol",
        durationBucket: "1-3m",
        failureClass: "unknown",
      },
    });
  });

  it("rejects unregistered names and drops unregistered properties", () => {
    expect(normalizeInheritedEvent("ui.clicked", { selector: "#private" }, context)).toBeNull();
    const surface = normalizeInheritedEvent(
      "surface.opened",
      { surface: "settings", path: "/Users/private" },
      context,
    );
    expect(surface?.properties).toEqual({
      surface: "settings",
      ...context,
      contractRevision: "3",
    });
  });

  it("classifies project-registration failures without accepting raw errors", () => {
    const failure = normalizeInheritedEvent(
      "project.add.failed",
      { stage: "registration", error: "/private/path could not be created" },
      context,
    );
    expect(failure).toMatchObject({
      privacyLevel: "essential",
      priority: "critical",
      properties: { stage: "registration" },
    });
    expect(JSON.stringify(failure)).not.toContain("/private/path");
  });
});
