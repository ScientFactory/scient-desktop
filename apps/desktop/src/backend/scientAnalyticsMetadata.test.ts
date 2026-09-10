import { describe, expect, it } from "@effect/vitest";
import { scientAnalyticsMetadata } from "./scientAnalyticsMetadata.ts";

describe("Scient release metadata", () => {
  it("honors explicit opt-in for isolated QA and an operator's release kill switch", () => {
    const release = { appVersion: "0.6.8", isPackaged: true, isDevelopment: false };
    expect(scientAnalyticsMetadata(release, "false").SCIENT_ANALYTICS_ENABLED).toBe("false");
    expect(scientAnalyticsMetadata(release, "invalid").SCIENT_ANALYTICS_ENABLED).toBe("false");
    expect(
      scientAnalyticsMetadata({ ...release, isDevelopment: true }, "true").SCIENT_ANALYTICS_ENABLED,
    ).toBe("true");
  });
  it("makes analytics available in packaged releases without setting consent", () => {
    expect(
      scientAnalyticsMetadata({ appVersion: "0.6.8", isPackaged: true, isDevelopment: false }),
    ).toEqual({
      SCIENT_ANALYTICS_APP_VERSION: "0.6.8",
      SCIENT_ANALYTICS_BUILD_CHANNEL: "stable",
      SCIENT_ANALYTICS_ENABLED: "true",
    });
  });
  it("does not count development or custom builds as stable releases", () => {
    expect(
      scientAnalyticsMetadata({ appVersion: "0.6.8", isPackaged: true, isDevelopment: true }),
    ).toEqual({
      SCIENT_ANALYTICS_APP_VERSION: "unknown",
      SCIENT_ANALYTICS_BUILD_CHANNEL: "development",
      SCIENT_ANALYTICS_ENABLED: "false",
    });
    expect(
      scientAnalyticsMetadata({
        appVersion: "0.6.8-custom",
        isPackaged: true,
        isDevelopment: false,
      }).SCIENT_ANALYTICS_BUILD_CHANNEL,
    ).toBe("unknown");
  });
});
