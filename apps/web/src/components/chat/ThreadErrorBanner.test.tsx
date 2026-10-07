import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import { RunId, TurnItemId } from "@t3tools/contracts";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isTokenLimitError,
  getTruncationNoticeKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("supersedes a truncated response notice when a newer run starts", () => {
    const items = [
      {
        id: TurnItemId.make("limit-one"),
        type: "notification" as const,
        source: { kind: "output_truncated" as const, stopReason: "length" },
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
  it("scopes token-limit dismissal to its occurrence, not every future failure", () => {
    const first = getThreadErrorBannerKey("env:limits", MODEL_TOKEN_LIMIT_MESSAGE, "turn-1");
    dismissThreadErrorBannerForSession(first);
    expect(isThreadErrorBannerDismissedForSession(first)).toBe(true);
    const next = getThreadErrorBannerKey("env:limits", MODEL_TOKEN_LIMIT_MESSAGE, "turn-2");
    expect(isThreadErrorBannerDismissedForSession(next)).toBe(false);
    expect(getThreadErrorBannerKey("env:limits", null, "turn-2")).toBeNull();
    expect(getThreadErrorBannerKey("env:limits", "Other error", "turn-1")).toBe(
      getThreadErrorBannerKey("env:limits", "Other error", "turn-2"),
    );
  });
  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });
});
