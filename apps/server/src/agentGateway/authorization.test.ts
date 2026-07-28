import { describe, expect, it } from "vitest";

import { authorizeThreadRead } from "./authorization.ts";

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
