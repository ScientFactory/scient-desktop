import { describe, expect, it } from "vite-plus/test";
import { activityIssuePolicy } from "./issuePresentation.ts";

describe("built-in issue ownership", () => {
  // regression: cdcacd8050 fix(chat): route capability failures to their owning controls
  it.each([
    // One row per kind: each is its own routing entry, so a misrouted kind fails only its row.
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
  });
  it.each(["extension.failed", "__proto__", undefined])(
    "does not infer an unknown issue from %s",
    (kind) => {
      expect(activityIssuePolicy(kind)).toBeUndefined();
    },
  );
});
