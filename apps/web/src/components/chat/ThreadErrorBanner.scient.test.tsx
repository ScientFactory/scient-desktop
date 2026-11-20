import { describe, expect, it } from "vite-plus/test";
import { RunId, TurnItemId } from "@t3tools/contracts";
import {
  dismissThreadErrorBannerForSession,
  getTruncationNoticeKey,
  isThreadErrorBannerDismissedForSession,
  isTokenLimitError,
} from "./ThreadErrorBanner";

describe("Scient thread error notices", () => {
  it("supersedes a truncated response notice when a newer run starts", () => {
    const items = [
      {
        id: TurnItemId.make("limit-one"),
        type: "notification" as const,
        source: {
          kind: "output_truncated" as const,
          stopReason: "length",
        },
        runId: RunId.make("one"),
      },
    ];
    const first = getTruncationNoticeKey("typed", items, "one", "completed");
    expect(first).not.toBeNull();
    expect(getTruncationNoticeKey("typed", items, "one", "running")).toBeNull();
    expect(getTruncationNoticeKey("typed", items, "one", "starting")).toBeNull();
    expect(getTruncationNoticeKey("typed", items, "two", "completed")).toBeNull();
    expect(getTruncationNoticeKey("typed", items, null, "completed")).toBeNull();
    expect(isTokenLimitError(null)).toBe(false);
    expect(isTokenLimitError("Unrelated failure")).toBe(false);
    dismissThreadErrorBannerForSession(first);
    expect(
      isThreadErrorBannerDismissedForSession(
        getTruncationNoticeKey("typed", [...items], "one", "completed"),
      ),
    ).toBe(true);
    expect(
      isThreadErrorBannerDismissedForSession(
        getTruncationNoticeKey("other-thread", items, "one", "completed"),
      ),
    ).toBe(false);
  });
});
