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
  signInHeld,
  siteMatches,
  withSignIn,
} from "./AccountDecisions.ts";
import { foldStoredAccounts } from "./AccountPersistence.ts";

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

  it("holds every attempt that didn't sign in, however long ago, and nothing else", () => {
    for (const held of ["failed", "needs-you", "password-rejected", "code-rejected", "limited"])
      expect(signInHeld({ state: held as "failed", at })).toBe(true);
    for (const free of ["signed-in", "signed-out", "unknown"])
      expect(signInHeld({ state: free as "unknown", at })).toBe(false);
    expect(signInHeld(undefined)).toBe(false);
  });

  it("won't sign back in by itself right after a sign-in that worked", () => {
    const worked = { signIn: { state: "signed-in", at } } as const;
    expect(automaticSignInOnHold(worked, minutes(5))).toBe(true);
    expect(automaticSignInOnHold(worked, minutes(16))).toBe(false);
  });

  it("only signs in by itself where that has worked or was never tried", () => {
    const later = minutes(100_000);
    expect(automaticSignInOnHold({}, later)).toBe(false);
    expect(automaticSignInOnHold({ signIn: { state: "signed-in", at } }, later)).toBe(false);
    expect(automaticSignInOnHold({ signIn: { state: "needs-you", at } }, later)).toBe(true);
    expect(automaticSignInOnHold({ signIn: { state: "failed", at } }, later)).toBe(true);
    // A session seen to end is when signing back in by itself helps.
    expect(automaticSignInOnHold({ signIn: { state: "signed-out", at } }, later)).toBe(false);
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

describe("what a sign-in or a look leaves on an account", () => {
  const at = "2026-10-31T10:00:00.000Z";
  const now = Date.parse(at);
  const summary = (fields: Partial<AccountSummary>) => fields as AccountSummary;
  const state = (account: AccountSummary) => account.signIn?.state;

  it("keeps a limit through later looks, until a session is seen working", () => {
    const limited = summary({ signIn: { state: "limited", at } });
    expect(state(withSignIn(limited, { state: "unknown", at }, now + 60_000, "look"))).toBe(
      "limited",
    );
    expect(state(withSignIn(limited, { state: "failed", at }, now + 60_000, "attempt"))).toBe(
      "limited",
    );
    expect(state(withSignIn(limited, { state: "signed-in", at }, now + 60_000, "look"))).toBe(
      "signed-in",
    );
    // The limit's hour is over, but a look is no user action: the hold stays.
    expect(state(withSignIn(limited, { state: "unknown", at }, now + 3_600_000, "look"))).toBe(
      "limited",
    );
  });

  it("keeps the hold when a session ends moments after signing in", () => {
    const signedIn = summary({ signIn: { state: "signed-in", at } });
    const after = withSignIn(signedIn, { state: "signed-out", at }, now + 60_000, "look");
    expect(state(after)).toBe("needs-you");
    expect(automaticSignInOnHold(after, now + 60_000)).toBe(true);
    expect(state(withSignIn(signedIn, { state: "signed-out", at }, now + 3_600_000, "look"))).toBe(
      "signed-out",
    );
  });

  it("clears a result that only needed a person, never a refused password", () => {
    const needed = summary({ signIn: { state: "needs-you", at } });
    expect(state(withSignIn(needed, { state: "signed-in", at }, now, "look"))).toBe("signed-in");
    expect(withSignIn(needed, { state: "signed-out", at }, now + 3_600_000, "look")).toBe(needed);
    const refused = summary({ signIn: { state: "password-rejected", at } });
    expect(withSignIn(refused, { state: "signed-in", at }, now, "look")).toBe(refused);
    expect(withSignIn(refused, { state: "signed-out", at }, now, "look")).toBe(refused);
    expect(withSignIn(refused, { state: "unknown", at }, now, "look")).toBe(refused);
    // A new attempt says something new about the saved password.
    expect(state(withSignIn(refused, { state: "signed-in", at }, now, "attempt"))).toBe(
      "signed-in",
    );
  });
});

describe("stored accounts from before one sign-in state", () => {
  const updatedAt = "2026-10-01T00:00:00.000Z";
  const at = "2026-10-31T10:00:00.000Z";
  const fold = (summary: object) =>
    (
      foldStoredAccounts({ format: 1, accounts: [{ summary: { updatedAt, ...summary } }] }) as {
        accounts: ReadonlyArray<{ summary: object }>;
      }
    ).accounts[0]!.summary;

  it("keeps a refusal over a later check, else the check, else the attempt", () => {
    expect(
      fold({
        lastSignInOutcome: "password-rejected",
        lastCheck: { state: "unknown", at },
        signedOut: true,
      }),
    ).toEqual({ updatedAt, signIn: { state: "password-rejected", at } });
    expect(fold({ lastSignInOutcome: "code-rejected" })).toEqual({
      updatedAt,
      signIn: { state: "code-rejected", at: updatedAt },
    });
    expect(
      fold({ lastSignInOutcome: "signed-in", lastCheck: { state: "needs-you", at, message: "m" } }),
    ).toEqual({ updatedAt, signIn: { state: "needs-you", at, detail: "m" } });
    expect(fold({ lastCheck: { state: "rejected", at, message: "Refused." } })).toEqual({
      updatedAt,
      signIn: { state: "failed", at, detail: "Refused." },
    });
    const password = { source: { type: "scient" } };
    expect(
      fold({
        secrets: { password },
        lastSignInOutcome: "signed-in",
        lastCheck: { state: "signed-out", at },
      }),
    ).toEqual({
      updatedAt,
      secrets: { password: { ...password, verifiedAt: at } },
      signIn: { state: "signed-out", at },
    });
    expect(fold({ lastSignInOutcome: "needs-user" })).toEqual({
      updatedAt,
      signIn: { state: "needs-you", at: updatedAt },
    });
    expect(fold({ signIn: { state: "signed-in", at } })).toEqual({
      updatedAt,
      signIn: { state: "signed-in", at },
    });
  });
});
