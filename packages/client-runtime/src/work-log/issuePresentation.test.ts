import { describe, expect, it } from "vite-plus/test";
import { activityIssuePolicy, isBackgroundActivityIssue } from "./issuePresentation.ts";

describe("built-in issue ownership", () => {
  it.each([
    ["checkpoint.capture.failed", "file-history", false],
    ["checkpoint.diff.failed", "changes", false],
    ["checkpoint.revert.failed", "restore", false],
    ["provider.approval.respond.failed", "approval", false],
    ["provider.user-input.respond.failed", "question", false],
    ["setup-script.failed", "workspace", false],
    ["provider.turn.start.failed", "turn", true],
    ["provider.turn.interrupt.failed", "turn", true],
    ["provider.session.stop.failed", "session", true],
    ["runtime.error", "turn", true],
  ] as const)("classifies %s by consequence", (kind, owner, severe) => {
    expect(activityIssuePolicy(kind)).toMatchObject({ owner, severe });
    expect(isBackgroundActivityIssue(kind)).toBe(owner === "file-history" || owner === "changes");
  });
  it.each(["extension.failed", "__proto__", "constructor", "tool.completed", undefined])(
    "does not infer an unknown issue from %s",
    (kind) => {
      expect(activityIssuePolicy(kind)).toBeUndefined();
      if (kind) expect(isBackgroundActivityIssue(kind)).toBe(false);
    },
  );
});
