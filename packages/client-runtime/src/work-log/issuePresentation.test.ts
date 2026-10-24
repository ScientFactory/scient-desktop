import { describe, expect, it } from "vite-plus/test";
import { activityIssuePolicy } from "./issuePresentation.ts";

describe("built-in issue ownership", () => {
  // regression: cdcacd8050 fix(chat): route capability failures to their owning controls
  it.each([
    ["provider.approval.respond.failed", "approval", false],
    ["provider.turn.interrupt.failed", "turn", true],
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
