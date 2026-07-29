import { describe, expect, it } from "vitest";

import { authorizeThreadDrive, authorizeThreadRead } from "./authorization.ts";

describe("authorizeThreadRead", () => {
  it("allows a read when the caller and target share the same project", () => {
    const decision = authorizeThreadRead({
      callerProjectId: "project-1",
      targetThreadId: "thread-1",
      targetProjectId: "project-1",
    });
    expect(decision).toEqual({ allow: true });
  });

  it("denies a read across projects with a thread_not_found code", () => {
    const decision = authorizeThreadRead({
      callerProjectId: "project-caller",
      targetThreadId: "thread-target",
      targetProjectId: "project-target",
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected denial");
    expect(decision.code).toBe("thread_not_found");
  });

  it("does not disclose the caller's or target's project id in the denial message", () => {
    const decision = authorizeThreadRead({
      callerProjectId: "project-caller",
      targetThreadId: "thread-target",
      targetProjectId: "project-target",
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected denial");
    expect(decision.message).not.toContain("project-caller");
    expect(decision.message).not.toContain("project-target");
    expect(decision.message).toContain("thread-target");
  });
});

describe("authorizeThreadDrive", () => {
  const base = {
    callerProjectId: "project-1",
    targetThreadId: "thread-target",
    targetProjectId: "project-1",
    callerRuntimeMode: "full-access" as const,
    callerEnvMode: "local" as const,
    targetRuntimeMode: "full-access" as const,
    targetEnvMode: "local" as const,
  };

  it("allows a same-project, same-privilege, same-environment drive", () => {
    expect(authorizeThreadDrive(base)).toEqual({ allow: true });
  });

  it("allows an approval-required caller to drive an approval-required target", () => {
    const decision = authorizeThreadDrive({
      ...base,
      callerRuntimeMode: "approval-required",
      targetRuntimeMode: "approval-required",
    });
    expect(decision).toEqual({ allow: true });
  });

  it("allows a full-access caller to drive an approval-required target (downward)", () => {
    const decision = authorizeThreadDrive({ ...base, targetRuntimeMode: "approval-required" });
    expect(decision).toEqual({ allow: true });
  });

  it("allows a worktree caller to drive a worktree target", () => {
    const decision = authorizeThreadDrive({
      ...base,
      callerEnvMode: "worktree",
      targetEnvMode: "worktree",
    });
    expect(decision).toEqual({ allow: true });
  });

  it("allows a local caller to drive a worktree target", () => {
    const decision = authorizeThreadDrive({ ...base, targetEnvMode: "worktree" });
    expect(decision).toEqual({ allow: true });
  });

  it("denies a cross-project drive as thread_not_found without disclosing projects", () => {
    const decision = authorizeThreadDrive({
      ...base,
      callerProjectId: "project-caller",
      targetProjectId: "project-target",
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected denial");
    expect(decision.code).toBe("thread_not_found");
    expect(decision.message).not.toContain("project-caller");
    expect(decision.message).not.toContain("project-target");
    expect(decision.message).toContain("thread-target");
  });

  it("denies an approval-required caller driving a full-access target (privilege cap)", () => {
    const decision = authorizeThreadDrive({ ...base, callerRuntimeMode: "approval-required" });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected denial");
    expect(decision.code).toBe("capability_denied");
    expect(decision.message).toContain("full-access");
  });

  it("denies a worktree caller driving a local target (worktree cap)", () => {
    const decision = authorizeThreadDrive({ ...base, callerEnvMode: "worktree" });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected denial");
    expect(decision.code).toBe("capability_denied");
    expect(decision.message).toContain("worktree");
  });

  it("applies the project floor before privilege caps", () => {
    // A cross-project target that would also fail the privilege cap must still
    // deny as thread_not_found, never revealing that the target exists.
    const decision = authorizeThreadDrive({
      ...base,
      callerProjectId: "project-caller",
      targetProjectId: "project-target",
      callerRuntimeMode: "approval-required",
      targetRuntimeMode: "full-access",
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("expected denial");
    expect(decision.code).toBe("thread_not_found");
  });
});
