import { describe, expect, it } from "@effect/vitest";
import fixture from "../fixtures/contract-v3.json" with { type: "json" };
import { buildAnalyticsConformanceFixture } from "./conformance.ts";
import { ANALYTICS_EVENT_NAMES, consentAllows, normalizeInheritedEvent } from "./contract.ts";
import { eventContractViolation } from "./wireContract.ts";

describe("analytics contract conformance corpus", () => {
  it("matches every registered normalizer exactly", () => {
    expect(buildAnalyticsConformanceFixture()).toEqual(fixture);
    expect(new Set(fixture.cases.map((entry) => entry.name)).size).toBe(
      ANALYTICS_EVENT_NAMES.length,
    );
    expect(JSON.stringify(fixture)).not.toMatch(/PRIVATE-CONTENT|example\.invalid|\/private\//u);
  });

  it("normalizes every provider and keeps custom model and version labels private", () => {
    for (const provider of [
      "codex",
      "claudeAgent",
      "antigravity",
      "droid",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]) {
      const result = normalizeInheritedEvent(
        "provider.turn.sent",
        {
          provider,
          model: "private-custom-name",
        },
        { appVersion: "private-custom-build", buildChannel: "stable" },
      );
      expect(result?.properties).toMatchObject({
        provider,
        modelKey: "other",
        appVersion: "unknown",
      });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });

  it("enforces each event's consent threshold and drops inherited unreviewed events", () => {
    for (const entry of fixture.cases) {
      const result = normalizeInheritedEvent(
        entry.name,
        {},
        { appVersion: "0.6.8", buildChannel: "stable" },
      );
      if (!result) throw new Error("Missing normalizer");
      for (const reserved of [
        "source",
        "event_id",
        "distinct_id",
        "consent_level",
        "privacy_level",
        "identity_type",
        "productFirstSeenAt",
        "$session_id",
        "$insert_id",
      ]) {
        expect(Object.hasOwn(result.properties, reserved)).toBe(false);
      }
      expect(
        eventContractViolation({
          name: result.name,
          privacyLevel: result.privacyLevel,
          consentLevel: result.privacyLevel,
          properties: result.properties,
        }),
      ).toBeNull();
      expect(consentAllows("off", result.privacyLevel)).toBe(false);
      expect(consentAllows(result.privacyLevel, result.privacyLevel)).toBe(true);
      if (result.privacyLevel === "diagnostic")
        expect(consentAllows("product", result.privacyLevel)).toBe(false);
      if (result.privacyLevel === "product")
        expect(consentAllows("essential", result.privacyLevel)).toBe(false);
    }
    expect(
      normalizeInheritedEvent(
        "client.connected",
        {},
        { appVersion: "0.6.8", buildChannel: "stable" },
      ),
    ).toBeNull();
  });
});
