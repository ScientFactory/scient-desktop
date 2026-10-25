import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  useClientSettings: () => undefined,
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

// SCIENT-FORK:START
const { browserProfileReportInput, getBrowserDefaults } = await import("./browserDefaults");
// SCIENT-FORK:END

const withDefaultProfile = (browserDefaultProfileId: string) => {
  settings.current = {
    browserDefaultViewport: { _tag: "fill" },
    browserDefaultZoomFactor: 1,
    browserDefaultAppearance: "system",
    browserAutoShowFloatingPreview: true,
    browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
    browserDefaultProfileId,
  };
  return getBrowserDefaults();
};

describe("getBrowserDefaults profile resolution", () => {
  it("refuses incognito as the default", () => {
    expect(withDefaultProfile(INCOGNITO_BROWSER_PROFILE_ID).profileId).toBe(
      DEFAULT_BROWSER_PROFILE_ID,
    );
  });
  // SCIENT-FORK:START

  it("reports the same persistent default used by local browser opens", () => {
    const defaults = withDefaultProfile(INCOGNITO_BROWSER_PROFILE_ID);

    expect(browserProfileReportInput(defaults)).toEqual({
      profiles: defaults.profiles,
      defaultProfileId: DEFAULT_BROWSER_PROFILE_ID,
    });
  });
  // SCIENT-FORK:END
});
