import { describe, expect, it } from "@effect/vitest";

import { durationBucket, modelKey, normalizeInheritedEvent } from "./contract.ts";

const context = {
  appVersion: "0.0.32",
  buildChannel: "development" as const,
};

describe("Scient analytics contract", () => {
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
    expect(surface?.properties).toEqual({ surface: "settings" });
  });
});
