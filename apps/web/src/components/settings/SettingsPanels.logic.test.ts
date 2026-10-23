import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  formatAboutVersionLabel,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
  shouldShowDesktopUpdateChannelSelector,
} from "./SettingsPanels.logic";

describe("about version label", () => {
  it("distinguishes development builds without changing release version labels", () => {
    expect(formatAboutVersionLabel("0.0.42", "Dev")).toBe("0.0.42 · Dev");
    expect(formatAboutVersionLabel("0.6.13", null)).toBe("0.6.13");
  });
});

describe("desktop update channel selector", () => {
  it("stays hidden for a stable-only compatibility policy", () => {
    expect(
      shouldShowDesktopUpdateChannelSelector({
        hasDesktopBridge: true,
        policy: "stable-only",
      }),
    ).toBe(false);
  });

  it("remains available to products that deliberately expose channel selection", () => {
    expect(
      shouldShowDesktopUpdateChannelSelector({
        hasDesktopBridge: true,
        policy: "user-selectable",
      }),
    ).toBe(true);
    expect(
      shouldShowDesktopUpdateChannelSelector({
        hasDesktopBridge: false,
        policy: "user-selectable",
      }),
    ).toBe(false);
  });
});

describe("typography settings restore", () => {
  it.each([300, 500] as const)("detects a weight-only change of %s", (fontWeightInterface) => {
    expect(
      getChangedTypographySettingLabels({ ...DEFAULT_UNIFIED_SETTINGS, fontWeightInterface }),
    ).toEqual(["Interface font"]);
  });
  it("detects family and size changes by font row", () => {
    expect(getChangedTypographySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeInterface: 19,
        fontFamilyCode: "Fira Code",
      }),
    ).toEqual(["Interface font", "Code font"]);
  });
});

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });

  it("labels each browser default that differs", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserDefaultViewport: { _tag: "freeform", width: 900, height: 600 },
        browserDefaultZoomFactor: 1.5,
        browserDefaultAppearance: "dark",
        browserRecordingFrameRate: 60,
        browserRecordingShowKeyPresses: true,
        browserRecordingShowMousePresses: true,
        browserLinkTarget: "system",
        browserAutoShowFloatingPreview: !DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
        pullRequestLinksOpenInApp: false,
      }),
    ).toEqual([
      "Browser viewport",
      "Browser zoom",
      "Browser appearance",
      "Recording frame rate",
      "Recording key presses",
      "Recording mouse presses",
      "Open links in",
      "Floating preview",
      "Open pull requests in Scient",
    ]);
  });
});
