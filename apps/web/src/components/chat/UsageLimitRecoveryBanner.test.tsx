import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});

describe("usageLimitRecoveryBannerItem with another signed-in model", () => {
  it("offers to continue with it, also when the reset time is unknown", () => {
    const item = usageLimitRecoveryBannerItem({
      runId: RunId.make("run-1"),
      errorCode: null,
      resetAt: null,
      stoppedAt: stoppedAt.toISOString(),
      settled: false,
      requestPending: false,
      snoozedUntil: null,
      recovery: null,
      timestampFormat: "12-hour",
      onChange: async () => {},
      continueWith: { modelName: "GPT-6 Luna", onContinue: () => {} },
    });
    expect(renderToStaticMarkup(<>{item.actions}</>)).toContain("Continue with GPT-6 Luna");
  });
});
