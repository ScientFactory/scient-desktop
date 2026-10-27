import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, defaultAccountControls } from "@t3tools/contracts";
import {
  applyApprovalDecision,
  authorizationDecision,
  effectiveProfile,
  inScope,
  siteMatches,
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
