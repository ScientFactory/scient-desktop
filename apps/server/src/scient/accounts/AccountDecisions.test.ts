import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import {
  applyApprovalDecision,
  authorizationDecision,
  automaticSignInOnHold,
  effectiveProfile,
  inScope,
  isGoogleSessionRow,
  signInOnHold,
  siteMatches,
  withCheck,
} from "./AccountDecisions.ts";

const projectId = ProjectId.make("synthetic-project");
const scope = { projectId, threadId: ThreadId.make("synthetic-thread"), unattended: false };
const controls = defaultAccountControls("website");

describe("account grant decisions", () => {
  it("limits project grants, including an empty project set and projectless sessions", () => {
    expect(inScope({ type: "all-projects" }, undefined)).toBe(true);
    expect(inScope({ type: "projects", projectIds: [] }, projectId)).toBe(false);
    expect(inScope({ type: "projects", projectIds: [projectId] }, undefined)).toBe(false);
    expect(inScope({ type: "projects", projectIds: [projectId] }, projectId)).toBe(true);
  });
  it("denies off, global-off and out-of-scope accounts before considering approval", () => {
    expect(authorizationDecision(false, controls, scope)).toEqual({
      decision: "denied",
      reason: "off",
    });
    expect(authorizationDecision(true, { ...controls, access: "off" }, scope)).toEqual({
      decision: "denied",
      reason: "off",
    });
    expect(
      authorizationDecision(
        true,
        { ...controls, scope: { type: "projects", projectIds: [] }, allowedProjects: [projectId] },
        scope,
      ),
    ).toEqual({ decision: "denied", reason: "out-of-scope" });
  });
  it("asks only attended sessions and treats a project exception as allowed", () => {
    const ask = { ...controls, access: "ask" as const };
    expect(authorizationDecision(true, ask, scope)).toEqual({ decision: "ask" });
    expect(authorizationDecision(true, ask, { ...scope, unattended: true })).toEqual({
      decision: "denied",
      reason: "declined",
    });
    expect(
      authorizationDecision(
        true,
        { ...ask, allowedProjects: [projectId] },
        { ...scope, unattended: true },
      ),
    ).toEqual({ decision: "allowed" });
    expect(authorizationDecision(true, controls, { ...scope, unattended: true })).toEqual({
      decision: "allowed",
    });
  });
  it("changes durable controls only for project and always approvals", () => {
    const ask = { ...controls, access: "ask" as const, allowedProjects: [projectId] };
    expect(applyApprovalDecision(ask, "once", projectId)).toBe(ask);
    expect(applyApprovalDecision(ask, "deny", projectId)).toBe(ask);
    expect(applyApprovalDecision(ask, "project", undefined)).toBe(ask);
    const other = ProjectId.make("another-project");
    expect(applyApprovalDecision(ask, "project", other).allowedProjects).toEqual([
      projectId,
      other,
    ]);
    expect(applyApprovalDecision(ask, "project", projectId).allowedProjects).toEqual([projectId]);
    expect(applyApprovalDecision(ask, "always", projectId).access).toBe("allowed");
  });
  it("uses default profile grants until a record overrides them", () => {
    const record = { ...effectiveProfile([], "profile"), access: "off" as const };
    expect(effectiveProfile([], "profile")).toMatchObject({
      access: "allowed",
      scope: { type: "all-projects" },
      scriptSignIn: true,
    });
    expect(effectiveProfile([record], "profile")).toBe(record);
  });
  it("binds website use to HTTPS domains or exact origins without lookalike matches", () => {
    expect(siteMatches(["example.com"], "https://login.example.com")).toBe(true);
    expect(siteMatches(["example.com"], "https://example.com.attacker.test")).toBe(false);
    expect(siteMatches(["example.com"], "https://notexample.com")).toBe(false);
    expect(siteMatches(["https://example.com:8443"], "https://example.com")).toBe(false);
    expect(siteMatches(["https://example.com:8443"], "https://example.com:8443")).toBe(true);
    expect(siteMatches(["example.com"], "http://example.com")).toBe(false);
    expect(siteMatches(["example.com"], "https://user@example.com")).toBe(false);
    expect(siteMatches(["example.com"], "https://example.com/path")).toBe(false);
    expect(siteMatches(["example.com"], "not a URL")).toBe(false);
  });
});

describe("sign-in holds", () => {
  const at = "2026-10-31T10:00:00.000Z";
  const now = Date.parse(at);
  const minutes = (count: number) => now + count * 60_000;

  it("keeps a failed or unfinished sign-in on hold for a while, and a refused one until it changes", () => {
    const failed = {
      lastSignInOutcome: "failed",
      lastCheck: { state: "unknown", at },
    } as const;
    expect(signInOnHold(failed, minutes(10))).toBe(true);
    expect(signInOnHold(failed, minutes(16))).toBe(false);
    expect(signInOnHold({ lastCheck: { state: "needs-you", at } }, minutes(10))).toBe(true);
    expect(signInOnHold({ lastCheck: { state: "needs-you", at } }, minutes(16))).toBe(false);
    expect(
      signInOnHold(
        { lastSignInOutcome: "password-rejected", lastCheck: { state: "rejected", at } },
        minutes(100_000),
      ),
    ).toBe(true);
    expect(signInOnHold({ lastCheck: { state: "signed-in", at } }, minutes(1))).toBe(false);
    // A one-time code the user typed wrong isn't something saved that needs fixing.
    expect(
      signInOnHold({ lastSignInOutcome: "code-rejected", secrets: {} }, minutes(100_000)),
    ).toBe(false);
  });

  it("won't sign back in by itself right after a sign-in that worked", () => {
    const worked = { lastCheck: { state: "signed-in", at } } as const;
    expect(automaticSignInOnHold(worked, minutes(5))).toBe(true);
    expect(automaticSignInOnHold(worked, minutes(16))).toBe(false);
  });

  it("only signs in by itself where that has worked or was never tried", () => {
    const later = minutes(100_000);
    expect(automaticSignInOnHold({}, later)).toBe(false);
    expect(automaticSignInOnHold({ lastSignInOutcome: "signed-in" }, later)).toBe(false);
    expect(automaticSignInOnHold({ lastSignInOutcome: "needs-user" }, later)).toBe(true);
    expect(automaticSignInOnHold({ lastSignInOutcome: "failed" }, later)).toBe(true);
  });
});

describe("Google session rows", () => {
  const details = {
    kind: "website",
    sites: ["google.com"],
    username: "a@example.com",
    profileId: "work",
  } as const;

  it("are the password-free rows for google.com, never a saved password", () => {
    expect(isGoogleSessionRow({ details, secrets: {} })).toBe(true);
    expect(
      isGoogleSessionRow({
        details,
        secrets: { password: { source: { type: "scient" } } },
      }),
    ).toBe(false);
    expect(
      isGoogleSessionRow({ details: { ...details, sites: ["accounts.google.com"] }, secrets: {} }),
    ).toBe(false);
  });
});

describe("what a check leaves on an account", () => {
  const at = "2026-10-31T10:00:00.000Z";
  const now = Date.parse(at);
  const summary = (fields: Partial<AccountSummary>) => fields as AccountSummary;

  it("keeps a limit through later looks, until a session is seen working", () => {
    const limited = summary({ lastCheck: { state: "limited", at } });
    expect(withCheck(limited, { state: "unknown", at }, now + 60_000).lastCheck?.state).toBe(
      "limited",
    );
    expect(withCheck(limited, { state: "signed-in", at }, now + 60_000).lastCheck?.state).toBe(
      "signed-in",
    );
  });

  it("clears a result that only needed a person, never a refused password", () => {
    expect(
      withCheck(summary({ lastSignInOutcome: "needs-user" }), { state: "signed-in", at }, now)
        .lastSignInOutcome,
    ).toBeUndefined();
    expect(
      withCheck(
        summary({ lastSignInOutcome: "password-rejected" }),
        { state: "signed-in", at },
        now,
      ).lastSignInOutcome,
    ).toBe("password-rejected");
  });
});
