import { describe, expect, it } from "vite-plus/test";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import { RunId, TurnItemId } from "@t3tools/contracts";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isTokenLimitError,
  getTruncationNoticeKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it.each([
    ["plain text", "  Could not start the turn.\nTry again.  "],
    ["invalid JSON", '{"error":{"message":"Cut off"'],
    ["an unfamiliar shape", '{"message":"Top-level message","status":400}'],
  ])("leaves %s unchanged", (_description, error) => {
    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });

  it("does not recursively unwrap the selected message", () => {
    const message = JSON.stringify({ error: { message: "Inner message" } });

    expect(getThreadErrorBannerMessage(JSON.stringify({ error: { message } }))).toBe(message);
  });
});

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

  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError);
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError);

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        secondError,
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
});
