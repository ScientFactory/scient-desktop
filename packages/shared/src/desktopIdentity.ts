// FILE: desktopIdentity.ts
// Purpose: Defines Scient's canonical desktop application identity across packaging and runtime.

export const SCIENT_APP_NAME = "Scient";
export const SCIENT_DESKTOP_SCHEME = "scient";
export const SCIENT_DESKTOP_ORIGIN = `${SCIENT_DESKTOP_SCHEME}://app`;
export const SCIENT_DESKTOP_ENTRY_URL = `${SCIENT_DESKTOP_ORIGIN}/index.html`;
export const SCIENT_DESKTOP_UPDATE_CHANNEL = "scient";
export const SCIENT_DESKTOP_DEB_UPDATE_CHANNEL = "scient-deb";
export const SCIENT_DESKTOP_UPDATES_ENABLED = true;
export const SCIENT_PRODUCTION_BUNDLE_ID = "com.scientfactory.scient";
export const SCIENT_DEVELOPMENT_BUNDLE_ID = `${SCIENT_PRODUCTION_BUNDLE_ID}.dev`;

export function scientDesktopUpdateChannel(
  platform: NodeJS.Platform,
  linuxPackageType: string | null,
): string {
  return platform === "linux" && linuxPackageType === "deb"
    ? SCIENT_DESKTOP_DEB_UPDATE_CHANNEL
    : SCIENT_DESKTOP_UPDATE_CHANNEL;
}

export function scientBundleId(isDevelopment: boolean): string {
  return isDevelopment ? SCIENT_DEVELOPMENT_BUNDLE_ID : SCIENT_PRODUCTION_BUNDLE_ID;
}
