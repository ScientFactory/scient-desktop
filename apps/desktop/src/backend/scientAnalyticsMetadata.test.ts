import { describe, expect, it } from "@effect/vitest";
import { scientAnalyticsMetadata } from "./scientAnalyticsMetadata.ts";

describe("Scient release metadata", () => {
  it("honors explicit opt-in for isolated QA and an operator's release kill switch", () => {
    const release = { appVersion: "0.6.8", isPackaged: true, isDevelopment: false };
    expect(
      scientAnalyticsMetadata(release, { SCIENT_ANALYTICS_ENABLED: "false" })
        .SCIENT_ANALYTICS_ENABLED,
    ).toBe("false");
    expect(
      scientAnalyticsMetadata(release, { SCIENT_ANALYTICS_ENABLED: "invalid" })
        .SCIENT_ANALYTICS_ENABLED,
    ).toBe("false");
    expect(
      scientAnalyticsMetadata(
        { ...release, isDevelopment: true },
        { SCIENT_ANALYTICS_ENABLED: "true" },
      ).SCIENT_ANALYTICS_ENABLED,
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
  const packagedEnabled = (env: Record<string, string>) =>
    scientAnalyticsMetadata({ appVersion: "0.6.8", isPackaged: true, isDevelopment: false }, env)
      .SCIENT_ANALYTICS_ENABLED;
  it("keeps a CI runner's packaged default off while still honoring explicit opt-in", () => {
    expect(packagedEnabled({ CI: "true" })).toBe("false");
    expect(packagedEnabled({ CI: "false" })).toBe("true");
    expect(packagedEnabled({ CI: "true", SCIENT_ANALYTICS_ENABLED: "true" })).toBe("true");
  });
  it("lets DO_NOT_TRACK switch analytics off over the default and every opt-in", () => {
    expect(packagedEnabled({ DO_NOT_TRACK: "1" })).toBe("false");
    expect(packagedEnabled({ DO_NOT_TRACK: "0" })).toBe("true");
    expect(packagedEnabled({ DO_NOT_TRACK: "true", SCIENT_ANALYTICS_ENABLED: "true" })).toBe(
      "false",
    );
    expect(
      packagedEnabled({ CI: "true", DO_NOT_TRACK: "1", SCIENT_ANALYTICS_ENABLED: "true" }),
    ).toBe("false");
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
