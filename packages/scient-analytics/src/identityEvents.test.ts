import { describe, expect, it } from "@effect/vitest";

import { normalizeInheritedEvent } from "./contract.ts";
import { ANALYTICS_CONTRACT_REVISION, eventContractViolation } from "./wireContract.ts";

const context = { appVersion: "0.6.28", buildChannel: "stable" as const };

const wire = (name: string, properties: Record<string, unknown>) =>
  eventContractViolation({
    name,
    privacyLevel: "product",
    consentLevel: "product",
    properties,
  });

describe("identity events", () => {
  it("sends a signed-in account's email and plan only on the account event", () => {
    const event = normalizeInheritedEvent(
      "install.account_observed",
      { provider: "claudeAgent", email: " Ada@Uni.EDU ", plan: "Claude Max", accountType: "max" },
      context,
    );
    expect(event?.properties).toMatchObject({
      provider: "claudeAgent",
      email: "ada@uni.edu",
      plan: "Claude Max",
      accountType: "max",
      contractRevision: ANALYTICS_CONTRACT_REVISION,
    });
    expect(wire("install.account_observed", { ...event!.properties })).toBeNull();
  });

  it("keeps rejecting email addresses everywhere else", () => {
    expect(wire("provider.turn.completed", { email: "ada@uni.edu" })).toContain("Private");
    expect(wire("install.profile_observed", { email: "ada@uni.edu" })).toContain("Private");
    expect(wire("install.account_observed", { plan: "ada@uni.edu" })).toContain("Private");
    expect(
      normalizeInheritedEvent("provider.turn.completed", { owner: "ada@uni.edu" }, context)
        ?.properties.owner,
    ).toBeUndefined();
  });

  it("drops an account event with neither a valid email nor a plan", () => {
    expect(
      normalizeInheritedEvent(
        "install.account_observed",
        { provider: "codex", email: "/Users/ada/.codex" },
        context,
      ),
    ).toBeNull();
    expect(
      normalizeInheritedEvent(
        "install.account_observed",
        { provider: "codex", plan: "Plus" },
        context,
      )?.properties,
    ).not.toHaveProperty("email");
  });

  it("sends the onboarding answers with bounded values", () => {
    const event = normalizeInheritedEvent(
      "install.profile_observed",
      {
        workKinds: "scientific, code",
        field: "neuroscience",
        role: "postdoc",
        otherWork: "Calcium imaging in mice",
      },
      context,
    );
    expect(event?.properties).toMatchObject({
      workKinds: ["scientific", "code"],
      field: "neuroscience",
      role: "postdoc",
      otherWork: "Calcium imaging in mice",
    });
    expect(wire("install.profile_observed", { ...event!.properties })).toBeNull();
    expect(
      normalizeInheritedEvent(
        "install.profile_observed",
        { workKinds: "", otherWork: "https://lab.example.org/me" },
        context,
      )?.properties,
    ).not.toHaveProperty("otherWork");
  });
});
