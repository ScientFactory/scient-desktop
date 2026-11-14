import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserProfile,
  type DesktopPreviewTabDefaults,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
  type PreviewZoomFactor,
} from "@t3tools/contracts";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
} from "~/hooks/useSettings";

import { resolveResponsiveBrowserViewportSize } from "./browserViewportLayout";
// SCIENT-FORK:START — Scient Accounts: profiles merged into Main are not offered.
import { activeProfiles, useRetiredProfiles } from "~/scient/accounts/activeProfiles";
// SCIENT-FORK:END

export interface BrowserDefaults {
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: PreviewZoomFactor;
  readonly appearance: PreviewAppearancePreference;
  readonly autoShowFloatingPreview: boolean;
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly profileId: string;
}

const toBrowserDefaults = (settings: {
  readonly browserDefaultViewport: PreviewViewportSetting;
  readonly browserDefaultZoomFactor: PreviewZoomFactor;
  readonly browserDefaultAppearance: PreviewAppearancePreference;
  readonly browserAutoShowFloatingPreview: boolean;
  readonly browserProfiles: ReadonlyArray<BrowserProfile>;
  readonly browserDefaultProfileId: string;
}): BrowserDefaults => {
  // SCIENT-FORK:START — Scient Accounts: profiles merged into Main are not offered.
  const profiles = activeProfiles(settings.browserProfiles);
  // SCIENT-FORK:END
  return {
    viewport: settings.browserDefaultViewport,
    zoomFactor: settings.browserDefaultZoomFactor,
    appearance: settings.browserDefaultAppearance,
    autoShowFloatingPreview: settings.browserAutoShowFloatingPreview,
    profiles,
    profileId:
      profiles.find(
        (profile) =>
          profile.id === settings.browserDefaultProfileId && profile.kind !== "incognito",
      )?.id ?? DEFAULT_BROWSER_PROFILE_ID,
  };
};

export function getBrowserDefaults(): BrowserDefaults {
  return toBrowserDefaults(getClientSettings());
}

/** New tabs retain their initial defaults, so wait for settings hydration. Read failures reject. */
export async function resolveBrowserDefaults(): Promise<BrowserDefaults> {
  await ensureClientSettingsHydrated();
  return getBrowserDefaults();
}

export function useBrowserDefaults(): BrowserDefaults {
  // SCIENT-FORK:START — Scient Accounts: a merge into Main re-renders and reselects.
  useRetiredProfiles();
  return useClientSettings((settings) => toBrowserDefaults(settings));
  // SCIENT-FORK:END
}

export function browserDefaultTabState(defaults: BrowserDefaults): DesktopPreviewTabDefaults {
  return { zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance };
}

// SCIENT-FORK:START — agents receive the same resolved default profile as local opens.
/** Browser profile list and resolved default sent to server-side agent tools. */
export function browserProfileReportInput(defaults: BrowserDefaults) {
  return {
    profiles: defaults.profiles,
    defaultProfileId: defaults.profileId,
  };
}
// SCIENT-FORK:END

const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const;

export function browserResponsiveViewportForToggle(input: {
  readonly defaults?: BrowserDefaults;
  readonly panelRect: { readonly width: number; readonly height: number } | null;
  readonly zoomFactor: number | undefined;
}): PreviewViewportSetting {
  const defaults = input.defaults ?? getBrowserDefaults();
  if (defaults.viewport._tag !== "fill") return defaults.viewport;
  const size = input.panelRect
    ? resolveResponsiveBrowserViewportSize(input.panelRect, input.zoomFactor)
    : FALLBACK_RESPONSIVE_VIEWPORT_SIZE;
  return { _tag: "freeform", ...size };
}
